import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import {
  filterAlreadyTracked,
  isAlreadyTracked,
  titleMatches,
} from "../src/watch/inband/backlog.ts";
import type { RawObservation } from "../src/watch/synthesize.ts";

function obs(over: Partial<RawObservation>): RawObservation {
  return {
    kind: "candidate-task",
    title: "x",
    detail: "d",
    evidence: [],
    proposal: "adopt-as-task",
    targetProjectSlug: null,
    ...over,
  };
}

describe("titleMatches", () => {
  test("equal normalized, or strong containment ≥12 chars", () => {
    expect(titleMatches("Add a dark mode toggle", "add a dark-mode toggle")).toBe(true); // norm-equal
    expect(titleMatches("Add a dark mode toggle", "Add a dark mode toggle to settings")).toBe(true); // contains
    expect(titleMatches("Refactor the auth module", "Add a dark mode toggle")).toBe(false);
    expect(titleMatches("fix", "fix the bug")).toBe(false); // too short to fuzzy-match
  });
});

describe("isAlreadyTracked", () => {
  test("matches against task titles and plan goals", () => {
    const backlog = { taskTitles: ["Wire up OAuth"], planGoals: ["Add a dark mode toggle"] };
    expect(isAlreadyTracked(backlog, "Add a dark mode toggle to settings")).toBe(true);
    expect(isAlreadyTracked(backlog, "Wire up OAuth")).toBe(true);
    expect(isAlreadyTracked(backlog, "Something brand new")).toBe(false);
  });
});

describe("filterAlreadyTracked", () => {
  test("drops project work already in the backlog; passes everything else through", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "watch-backlog-"));
    const dbPath = path.join(root, "data.db");
    try {
      runMigrations(dbPath);
      const db = createDb(dbPath);
      const projectId = createId();
      const now = Date.now();
      db.insert(schema.projects)
        .values({
          id: projectId,
          slug: "alpha",
          name: "Alpha",
          ceremony: "personal",
          workdirPath: path.join(root, "alpha"), // no .factory/work → listTasks yields []
          createdAt: now,
          lastActivityAt: now,
        })
        .run();
      db.insert(schema.plans)
        .values({
          id: createId(),
          kind: "feature_plan",
          status: "drafting",
          projectId,
          goal: "Add a dark mode toggle",
          draft: "{}",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const input = [
        // dup of the drafting plan, project-scoped work → DROP
        obs({
          proposal: "draft-feature-plan",
          targetProjectSlug: "alpha",
          title: "Add a dark mode toggle to settings",
        }),
        // genuinely new project work → KEEP
        obs({
          proposal: "adopt-as-task",
          targetProjectSlug: "alpha",
          title: "Refactor the auth module",
        }),
        // same title but not a WORK proposal → KEEP (can't duplicate a backlog item)
        obs({ proposal: "note-only", targetProjectSlug: "alpha", title: "Add a dark mode toggle" }),
        // operator-level (no project) → KEEP
        obs({
          proposal: "adopt-as-task",
          targetProjectSlug: null,
          title: "Add a dark mode toggle",
        }),
        // unknown project → KEEP (can't resolve → can't dedup)
        obs({
          proposal: "adopt-as-task",
          targetProjectSlug: "ghost",
          title: "Add a dark mode toggle",
        }),
      ];

      const { kept, dropped } = await filterAlreadyTracked(db, input);
      expect(dropped).toBe(1);
      expect(kept).toHaveLength(4);
      expect(kept.some((o) => o.title === "Add a dark mode toggle to settings")).toBe(false);
      expect(kept.some((o) => o.title === "Refactor the auth module")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
