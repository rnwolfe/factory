import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { createTask } from "../src/projects/tasks.ts";
import { collectIdleColdStarts } from "../src/workers/idle-advance.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-idle-"));
  runMigrations(path.join(root, "data.db"));
  const db = createDb(path.join(root, "data.db"));
  return { root, db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function seedProject(
  db: ReturnType<typeof createDb>,
  root: string,
  opts: {
    slug: string;
    autoAdvance?: boolean;
    autonomyMode?: "collaborative" | "autonomous";
    tag?: "active" | "past";
    autonomyConfig?: string | null;
    withReadyTask?: boolean;
  },
) {
  const id = createId();
  const workdirPath = path.join(root, "projects", opts.slug);
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id,
      slug: opts.slug,
      name: opts.slug,
      ceremony: "tinker",
      workdirPath,
      autoAdvance: opts.autoAdvance ?? true,
      autonomyMode: opts.autonomyMode ?? "autonomous",
      tag: opts.tag ?? "active",
      autonomyConfig: opts.autonomyConfig ?? null,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  if (opts.withReadyTask !== false) {
    await createTask({ workdirPath, taskBackend: "file" }, { title: "Do it", body: "x" });
  }
  return id;
}

async function firstCandidateFor(
  db: ReturnType<typeof createDb>,
  projectId: string,
): Promise<boolean> {
  const cands = await collectIdleColdStarts(db);
  return cands.some((c) => c.projectId === projectId);
}

describe("collectIdleColdStarts (ADR-022)", () => {
  test("picks the ready task of an idle autonomous auto-advance project", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, { slug: "signpost" });
      const cands = await collectIdleColdStarts(h.db);
      expect(cands).toEqual([{ projectId: id, taskId: "task-001" }]);
    } finally {
      h.cleanup();
    }
  });

  test("excludes collaborative projects (not top rung)", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, { slug: "collab", autonomyMode: "collaborative" });
      expect(await firstCandidateFor(h.db, id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("excludes projects with auto-advance off", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, { slug: "manual", autoAdvance: false });
      expect(await firstCandidateFor(h.db, id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("excludes archived projects", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, { slug: "archived", tag: "past" });
      expect(await firstCandidateFor(h.db, id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("excludes a project with a run already in flight", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, { slug: "busy" });
      h.db
        .insert(schema.runs)
        .values({
          id: createId(),
          projectId: id,
          status: "running",
          branch: "factory/run-x",
          worktreePath: "/tmp/x",
          startedAt: Date.now(),
          iterationCount: 0,
          budgetSeconds: 60,
        })
        .run();
      expect(await firstCandidateFor(h.db, id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("excludes a project with a held (needs_review) run — no futile re-run loop", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, { slug: "held" });
      // A gate-held run whose task is still `ready` must NOT be cold-started
      // again (the schema-task loop this guard fixes).
      h.db
        .insert(schema.runs)
        .values({
          id: createId(),
          projectId: id,
          taskId: "task-001",
          status: "needs_review",
          branch: "factory/run-y",
          worktreePath: "/tmp/y",
          startedAt: Date.now(),
          iterationCount: 0,
          budgetSeconds: 60,
        })
        .run();
      expect(await firstCandidateFor(h.db, id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("excludes a project with no startable task", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, { slug: "empty", withReadyTask: false });
      expect(await firstCandidateFor(h.db, id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("per-project emergency stop halts cold-start", async () => {
    const h = setup();
    try {
      const id = await seedProject(h.db, h.root, {
        slug: "estop",
        autonomyConfig: JSON.stringify({ autorun: { emergencyStop: true } }),
      });
      expect(await firstCandidateFor(h.db, id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
