import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, eq } from "drizzle-orm";

import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { applyPostMergeRunOutcome } from "../src/workers/post-merge.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Focused unit tests for the auto-advance decision in
 * `applyPostMergeRunOutcome`. The integration suites
 * (`merge-failure-approve`, `post-merge-race`) exercise the full merge →
 * reconcile → advance chain against a live runner; these isolate the
 * branch logic by stubbing execution at the worker-pool seam:
 * `pool.submit` is spied to a no-op so the auto-advance `submitRun` still
 * inserts its `queued` run row (observable) but `executeRun` — and any
 * real tmux/agent spawn — never fires.
 */

// Defensive: nothing here reaches tmux (pool.submit is stubbed), but pin a
// throwaway socket per CLAUDE.md so a stray call could never touch the
// operator's default server.
process.env.FACTORY_TMUX_SOCKET = `factory-test-postmerge-${process.pid}`;

async function git(args: string[], cwd: string): Promise<void> {
  const p = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    const err = await new Response(p.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
  }
}

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-post-merge-unit-"));
  const dbPath = path.join(root, "data.db");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(path.join(root, "projects"), { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const runs = new RunRegistry();
  const pool = new WorkerPool(1);
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
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
  return {
    config,
    db,
    events,
    runs,
    pool,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

interface SeedTask {
  id: string;
  status: "ready" | "done" | "blocked";
  blockedBy?: string[];
}

interface SeedOpts {
  tasks: SeedTask[];
  /** id of the task the just-finished run completed. Seeded `done` on main. */
  justFinishedId: string;
  autoAdvance?: boolean;
  /** Status of the run row applyPostMergeRunOutcome is called with. */
  runStatus?: (typeof schema.runStatusEnum)[number];
}

interface SeedResult {
  projectId: string;
  workdirPath: string;
  runId: string;
}

function taskFileBody(t: SeedTask): string {
  const lines = [`---`, `id: ${t.id}`, `title: ${t.id}`, `status: ${t.status}`];
  if (t.blockedBy && t.blockedBy.length > 0) {
    lines.push(`blockedBy:`);
    for (const dep of t.blockedBy) lines.push(`  - ${dep}`);
  }
  lines.push(`---`, ``, `body`, ``);
  return lines.join("\n");
}

async function seedProject(h: Harness, opts: SeedOpts): Promise<SeedResult> {
  const slug = "post-merge-unit";
  const projectId = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });

  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);

  await mkdir(path.join(workdirPath, ".factory", "work"), { recursive: true });
  for (const t of opts.tasks) {
    await writeFile(
      path.join(workdirPath, ".factory", "work", `${t.id}-demo.md`),
      taskFileBody(t),
      "utf8",
    );
  }
  await writeFile(path.join(workdirPath, "README.md"), "# init\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "init"], workdirPath);

  const now = Date.now();
  h.db
    .insert(schema.projects)
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
      autoAdvance: opts.autoAdvance ?? true,
      model: null,
      archivedAt: null,
    })
    .run();

  const runId = createId();
  h.db
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      taskId: opts.justFinishedId,
      status: opts.runStatus ?? "completed",
      agentName: "claude-code",
      branch: `factory/run-${runId}`,
      worktreePath: path.join(h.root, "worktrees", slug, runId),
      startedAt: now - 60_000,
      endedAt: now - 1_000,
      budgetSeconds: 0,
      summary: "done",
    })
    .run();

  return { projectId, workdirPath, runId };
}

function runsForTask(h: Harness, projectId: string, taskId: string) {
  return h.db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.taskId, taskId)))
    .all();
}

function callPostMerge(h: Harness, runId: string) {
  return applyPostMergeRunOutcome(
    { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
    runId,
  );
}

describe("applyPostMergeRunOutcome · auto-advance", () => {
  test("auto-advance on + a ready next task → submits the next task", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      // submitRun inserted a queued run row for the next ready task...
      const next = runsForTask(h, seed.projectId, "task-002");
      expect(next.length).toBe(1);
      expect(next[0]?.status).toBe("queued");
      // ...and it went through the pool (execution stubbed).
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("another run already queued on the project → no submit (no double-fire)", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready" },
        ],
      });

      // Operator (or a prior helper invocation) already advanced.
      const preexistingId = createId();
      h.db
        .insert(schema.runs)
        .values({
          id: preexistingId,
          projectId: seed.projectId,
          taskId: "task-002",
          status: "queued",
          agentName: "claude-code",
          branch: `factory/run-${preexistingId}`,
          worktreePath: path.join(h.root, "worktrees", "post-merge-unit", preexistingId),
          startedAt: Date.now(),
          budgetSeconds: 0,
        })
        .run();

      await callPostMerge(h, seed.runId);

      // Only the pre-existing run for task-002 — helper did not double-submit.
      const task002 = runsForTask(h, seed.projectId, "task-002");
      expect(task002.length).toBe(1);
      expect(task002[0]?.id).toBe(preexistingId);
      expect(submitSpy).not.toHaveBeenCalled();
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("source run not `completed` (merge-failure hold) → no advance", async () => {
    // The runner holds auto-advance on a merge failure by not invoking this
    // helper while `mergeFailureNote` is set (runner.ts). At the unit level the
    // guard is `run.status !== 'completed'`: a run left non-terminal (e.g.
    // `blocked`) must never advance the queue.
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        runStatus: "blocked",
        tasks: [
          { id: "task-001", status: "blocked" },
          { id: "task-002", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      expect(runsForTask(h, seed.projectId, "task-002").length).toBe(0);
      expect(submitSpy).not.toHaveBeenCalled();
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("next task blocked by an unfinished dependency → skipped, next startable picked (ADR-019)", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      // task-002 is `ready` but blocked by task-099 (still ready, not terminal)
      // → not startable. task-003 is startable and must be picked instead.
      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready", blockedBy: ["task-099"] },
          { id: "task-003", status: "ready" },
          { id: "task-099", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      expect(runsForTask(h, seed.projectId, "task-002").length).toBe(0);
      const picked = runsForTask(h, seed.projectId, "task-003");
      expect(picked.length).toBe(1);
      expect(picked[0]?.status).toBe("queued");
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("empty ready queue → no submit, and a queue-empty nudge is emitted", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      // Enable the (default-off) queue-empty nudge so the drain signal is observable.
      h.db
        .insert(schema.settings)
        .values({ key: "notify-on-queue-empty", value: "true", updatedAt: Date.now() })
        .run();

      const seed = await seedProject(h, {
        autoAdvance: true,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          // No later ready task — the queue is drained.
          { id: "task-000", status: "ready" },
        ],
      });

      const inbox: string[] = [];
      h.events.subscribe((e) => {
        if (e.channel === "inbox") inbox.push(e.kind);
      });

      await callPostMerge(h, seed.runId);

      // No run submitted (nothing ready after task-001; pickNextReadyTask does
      // not wrap back to the earlier task-000).
      expect(submitSpy).not.toHaveBeenCalled();
      // A queue-empty nudge decision was recorded and surfaced to the inbox.
      const nudges = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.kind, "queue_empty"),
          ),
        )
        .all();
      expect(nudges.length).toBe(1);
      expect(nudges[0]?.status).toBe("pending");
      expect(inbox).toContain("decision_created");
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });

  test("auto-advance off → no submit even with a ready next task", async () => {
    const h = setupHarness();
    const submitSpy = spyOn(h.pool, "submit").mockResolvedValue(undefined);
    try {
      const seed = await seedProject(h, {
        autoAdvance: false,
        justFinishedId: "task-001",
        tasks: [
          { id: "task-001", status: "done" },
          { id: "task-002", status: "ready" },
        ],
      });

      await callPostMerge(h, seed.runId);

      expect(runsForTask(h, seed.projectId, "task-002").length).toBe(0);
      expect(submitSpy).not.toHaveBeenCalled();
    } finally {
      submitSpy.mockRestore();
      h.cleanup();
    }
  });
});
