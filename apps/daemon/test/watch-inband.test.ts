import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { createInBandGroomJob } from "../src/watch/inband/groom-job.ts";
import { detectRunFailureSignals } from "../src/watch/inband/run-health.ts";
import type { RawObservation } from "../src/watch/synthesize.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "watch-inband-"));
  const dbPath = path.join(root, "data.db");
  runMigrations(dbPath);
  const db = createDb(dbPath);
  return { db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function addProject(db: ReturnType<typeof createDb>, slug: string): string {
  const id = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ceremony: "personal",
      workdirPath: `/tmp/${slug}`,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return id;
}

function addRun(
  db: ReturnType<typeof createDb>,
  projectId: string,
  status: "completed" | "failed" | "aborted",
  startedAt: number,
) {
  const id = createId();
  db.insert(schema.runs)
    .values({
      id,
      projectId,
      taskId: null,
      status,
      branch: `factory/run-${id}`,
      worktreePath: `/tmp/wt/${id}`,
      startedAt,
      budgetSeconds: 0,
      baseRef: "abc1234",
      agentName: "claude-code",
      summary: null,
    })
    .run();
}

describe("detectRunFailureSignals", () => {
  test("flags a project whose last 3 terminal runs all failed", () => {
    const { db, cleanup } = setup();
    try {
      const rivr = addProject(db, "rivr");
      addRun(db, rivr, "failed", 100);
      addRun(db, rivr, "failed", 200);
      addRun(db, rivr, "failed", 300);

      // a recovering project: older fails, but the most recent succeeded
      const alpha = addProject(db, "alpha");
      addRun(db, alpha, "failed", 100);
      addRun(db, alpha, "failed", 200);
      addRun(db, alpha, "completed", 300);

      const obs = detectRunFailureSignals(db);
      expect(obs).toHaveLength(1);
      expect(obs[0]?.targetProjectSlug).toBe("rivr");
      expect(obs[0]?.proposal).toBe("adopt-as-task");
      expect(obs[0]?.kind).toBe("candidate-task");
      expect(obs[0]?.title).toContain("rivr");
    } finally {
      cleanup();
    }
  });

  test("ignores projects with fewer than 3 terminal runs", () => {
    const { db, cleanup } = setup();
    try {
      const p = addProject(db, "newproj");
      addRun(db, p, "failed", 100);
      addRun(db, p, "failed", 200);
      expect(detectRunFailureSignals(db)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("createInBandGroomJob", () => {
  const sample: RawObservation = {
    kind: "candidate-task",
    title: "Investigate repeated run failures on rivr",
    detail: "d",
    evidence: [],
    proposal: "adopt-as-task",
    targetProjectSlug: "rivr",
  };

  test("runs detect → dedupe → save when there are signals", async () => {
    const saved: RawObservation[][] = [];
    const job = createInBandGroomJob({
      cadence: () => "daily",
      detect: () => [sample],
      dedupeAgainstBacklog: async (o) => ({ kept: o, dropped: 0 }),
      saveObservations: (o) => {
        saved.push(o);
        return { inserted: o.length, skipped: 0 };
      },
    });
    await job.run();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toHaveLength(1);
  });

  test("no signals → nothing saved", async () => {
    const saved: RawObservation[][] = [];
    const job = createInBandGroomJob({
      cadence: () => "daily",
      detect: () => [],
      dedupeAgainstBacklog: async (o) => ({ kept: o, dropped: 0 }),
      saveObservations: (o) => {
        saved.push(o);
        return { inserted: 0, skipped: 0 };
      },
    });
    await job.run();
    expect(saved).toHaveLength(0);
  });
});
