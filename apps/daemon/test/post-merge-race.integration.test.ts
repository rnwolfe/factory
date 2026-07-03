import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";

import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { createTask } from "../src/projects/tasks.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Regression guard for the auto-advance double-submit race. Two runs on one
 * project finalizing concurrently used to both observe "no other active runs"
 * and both submit — `pickNextReadyTask` handing both the same task → a
 * duplicate run on one task. A per-project keyed mutex (post-merge.ts) now
 * serializes the entire check-then-submit sequence, so the second finalization
 * sees the first's queued run and backs off.
 *
 * The stubbed `submitRun` faithfully simulates the real one's load-bearing side
 * effect — inserting a `queued` run row — which is exactly what the guard query
 * keys on. Under the mutex, exactly one submit happens.
 */

// Shared, mutable across the test: how many times the stub was invoked, and a
// handle to the live db so the stub can insert the queued run the guard reads.
const state: {
  submitCount: number;
  db: ReturnType<typeof createDb> | null;
  projectId: string | null;
} = { submitCount: 0, db: null, projectId: null };

// Preserve real exports; override only submitRun. post-merge dynamically
// imports { submitRun } from this module.
import * as submitReal from "../src/workers/submit.ts";

const realSubmitRun = submitReal.submitRun;

beforeAll(() => {
  mock.module("../src/workers/submit.ts", () => ({
    ...submitReal,
    submitRun: async (_deps: unknown, _input: { projectId: string; taskId?: string | null }) => {
      state.submitCount++;
      // Simulate the real submit's side effect: a queued run row on the
      // project. This is what the auto-advance `others` guard reads to detect
      // "someone already advanced".
      const runId = createId();
      state.db
        ?.insert(schema.runs)
        .values({
          id: runId,
          projectId: state.projectId ?? "",
          taskId: _input.taskId ?? null,
          status: "queued",
          agentName: "claude-code",
          branch: `factory/run-${runId}`,
          worktreePath: `/tmp/${runId}`,
          startedAt: Date.now(),
          budgetSeconds: 0,
        })
        .run();
      return { runId };
    },
  }));
});
afterAll(() => {
  mock.module("../src/workers/submit.ts", () => ({
    ...submitReal,
    submitRun: realSubmitRun,
  }));
});

interface Harness {
  deps: {
    config: FactoryConfig;
    db: ReturnType<typeof createDb>;
    events: EventBus;
    runs: RunRegistry;
    pool: WorkerPool;
  };
  projectId: string;
  finishedRunIds: [string, string];
  cleanup: () => void;
}

async function setup(): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-postmerge-race-"));
  const dbPath = path.join(root, "data.db");
  const slug = "race-demo";
  const workdirPath = path.join(root, "projects", slug);
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();

  const projectId = createId();
  const now = Date.now();
  db.insert(schema.projects)
    .values({
      id: projectId,
      slug,
      name: slug,
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath,
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: true,
      model: null,
      archivedAt: null,
    })
    .run();

  // One ready task on disk for auto-advance to pick.
  await createTask(
    { workdirPath, taskBackend: "file" },
    { title: "The next task", body: "do it", status: "ready" },
  );

  // Two completed runs, no taskId (so the reconcile step is skipped and both
  // calls fall straight through to the auto-advance section).
  const finishedRunIds: [string, string] = [createId(), createId()];
  for (const id of finishedRunIds) {
    db.insert(schema.runs)
      .values({
        id,
        projectId,
        taskId: null,
        status: "completed",
        agentName: "claude-code",
        branch: `factory/run-${id}`,
        worktreePath: `/tmp/${id}`,
        startedAt: now,
        budgetSeconds: 0,
      })
      .run();
  }

  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot: path.join(root, "worktrees"),
    dbPath,
    maxConcurrentRuns: 4,
    defaultRunBudgetSeconds: 60,
    runIdleTimeoutSeconds: 1200,
    agentBudgetSeconds: 0,
    eventRetentionDays: 30,
    gitAuthor: { name: "Test", email: "test@test" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    githubReplyAllowlist: [],
    publicBaseUrl: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };

  state.submitCount = 0;
  state.db = db;
  state.projectId = projectId;

  return {
    deps: { config, db, events, runs: new RunRegistry(), pool: new WorkerPool(4) },
    projectId,
    finishedRunIds,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("applyPostMergeRunOutcome · auto-advance double-submit race", () => {
  test("two concurrent finalizations submit the next ready task exactly once", async () => {
    const h = await setup();
    try {
      const { applyPostMergeRunOutcome } = await import("../src/workers/post-merge.ts");
      await Promise.all([
        applyPostMergeRunOutcome(h.deps, h.finishedRunIds[0]),
        applyPostMergeRunOutcome(h.deps, h.finishedRunIds[1]),
      ]);
      // The mutex serialized the check-then-submit: the second finalization saw
      // the first's queued run and backed off.
      expect(state.submitCount).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("a single finalization still advances (behavior unchanged)", async () => {
    const h = await setup();
    try {
      const { applyPostMergeRunOutcome } = await import("../src/workers/post-merge.ts");
      await applyPostMergeRunOutcome(h.deps, h.finishedRunIds[0]);
      expect(state.submitCount).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
