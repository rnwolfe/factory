import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, eq } from "drizzle-orm";

import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import { decisionsRouter } from "../src/routers/decisions.ts";
import { ScriptRegistry } from "../src/scripts/registry.ts";
import { createCallerFactory } from "../src/trpc.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { applyPostMergeRunOutcome } from "../src/workers/post-merge.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Cover the operator-driven repair when the runner's initial merge fails
 * but the operator approves the merge_failure decision and the retry
 * succeeds. Before this, the task stayed in a non-done state and auto-
 * advance never fired even though the run row was `completed`. The shared
 * post-merge helper now reconciles both.
 */

const createCaller = createCallerFactory(decisionsRouter);

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const p = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const code = await p.exited;
  return { exitCode: code, stdout };
}

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  events: EventBus;
  published: DaemonEvent[];
  runs: RunRegistry;
  pool: WorkerPool;
  caller: ReturnType<typeof createCaller>;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-merge-approve-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
  const runs = new RunRegistry();
  // Concurrency of 1 — every queued run we need to assert on is observable
  // directly off the rows table without racing the executor.
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
    agentBudgetSeconds: 0,
    gitAuthor: { name: "Test", email: "test@test" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  const ctx: DaemonContext = {
    db,
    events,
    runs,
    pool,
    config,
    scripts: new ScriptRegistry(events),
    authorized: true,
  };
  const caller = createCaller(ctx);
  return {
    config,
    db,
    events,
    published,
    runs,
    pool,
    caller,
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

interface SeedOpts {
  taskId?: string;
  initialTaskStatus?: "ready" | "in_progress";
  /** When set, an additional ready task gets seeded so auto-advance has something to pick. */
  withNextReadyTask?: boolean;
  autoAdvance?: boolean;
}

interface SeedResult {
  projectId: string;
  workdirPath: string;
  runId: string;
  branch: string;
  decisionId: string;
  taskId: string;
  nextTaskId: string | null;
}

async function seedProjectWithCompletedRun(h: Harness, opts: SeedOpts = {}): Promise<SeedResult> {
  const taskId = opts.taskId ?? "task-007";
  const slug = "merge-approve-demo";
  const projectId = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });

  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);

  await mkdir(path.join(workdirPath, ".factory", "work"), { recursive: true });
  const taskFilePath = path.join(workdirPath, ".factory", "work", `${taskId}-demo.md`);
  await writeFile(
    taskFilePath,
    `---\nid: ${taskId}\ntitle: demo\nstatus: ${opts.initialTaskStatus ?? "ready"}\n---\n\nbody\n`,
    "utf8",
  );

  let nextTaskId: string | null = null;
  if (opts.withNextReadyTask) {
    nextTaskId = "task-008";
    await writeFile(
      path.join(workdirPath, ".factory", "work", `${nextTaskId}-next.md`),
      `---\nid: ${nextTaskId}\ntitle: next\nstatus: ready\n---\n\nbody\n`,
      "utf8",
    );
  }

  await writeFile(path.join(workdirPath, "README.md"), "# init\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "init"], workdirPath);

  // Create the run's branch with two commits: an "agent work" commit plus
  // the runner's pre-merge task-status-done commit. The merge_failure path
  // is exercised by leaving a conflicting file on main so the initial
  // merge would fail — but we seed the merge_failure decision directly
  // without invoking the runner, so we just need a divergent branch.
  const branch = `factory/run-${createId()}`;
  await git(["checkout", "-b", branch], workdirPath);
  await writeFile(path.join(workdirPath, "feature.md"), "# feature\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "feat: feature"], workdirPath);
  // Pre-merge task status update commit — what runner.ts:485 produces.
  await writeFile(
    taskFilePath,
    `---\nid: ${taskId}\ntitle: demo\nstatus: done\n---\n\nbody\n`,
    "utf8",
  );
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", `chore: ${taskId} status -> done`], workdirPath);
  await git(["checkout", "main"], workdirPath);

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
      taskId,
      status: "completed",
      agentName: "claude-code",
      branch,
      worktreePath: path.join(h.root, "worktrees", slug, runId),
      startedAt: now - 60_000,
      endedAt: now - 1_000,
      budgetSeconds: 0,
      summary: "Agent finished the work; merge into main failed.",
    })
    .run();

  const decisionId = createId();
  h.db
    .insert(schema.decisions)
    .values({
      id: decisionId,
      kind: "merge_failure",
      projectId,
      outcome: "merge:dirty",
      payload: {
        runId,
        taskId,
        branch,
        reason: "dirty",
        message: "main was dirty; merge aborted",
      },
      status: "pending",
      createdAt: now,
    })
    .run();

  return { projectId, workdirPath, runId, branch, decisionId, taskId, nextTaskId };
}

describe("decisionsRouter.action · approve merge_failure", () => {
  test("retry merge lands task as done on main and fires auto-advance", async () => {
    const h = setupHarness();
    try {
      const seed = await seedProjectWithCompletedRun(h, {
        initialTaskStatus: "ready",
        withNextReadyTask: true,
        autoAdvance: true,
      });

      // Before approve: task on main still shows the original status (the
      // run's branch hasn't been merged yet).
      const beforeTask = await Bun.file(
        path.join(seed.workdirPath, ".factory", "work", `${seed.taskId}-demo.md`),
      ).text();
      expect(beforeTask).toContain("status: ready");

      // Approve.
      const result = await h.caller.action({
        decisionId: seed.decisionId,
        action: "approve",
      });
      expect(result.ok).toBe(true);
      expect(result.mergedSha).not.toBeNull();

      // Task file on main now reflects done — the run branch's pre-merge
      // task-status commit landed via the merge.
      const afterTask = await Bun.file(
        path.join(seed.workdirPath, ".factory", "work", `${seed.taskId}-demo.md`),
      ).text();
      expect(afterTask).toContain("status: done");

      // Decision actioned.
      const decision = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, seed.decisionId))
        .get();
      expect(decision?.status).toBe("actioned");

      // Auto-advance fired: a queued run row was inserted for the next ready
      // task. We assert on the row directly (not on whether the worker
      // executed it) so the test stays deterministic.
      const queued = h.db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.projectId, seed.projectId), eq(schema.runs.taskId, "task-008")))
        .all();
      expect(queued.length).toBeGreaterThanOrEqual(1);
    } finally {
      h.cleanup();
    }
  });

  test("helper reconciles task status when operator's manual merge picked stale main version", async () => {
    const h = setupHarness();
    try {
      const seed = await seedProjectWithCompletedRun(h, {
        initialTaskStatus: "ready",
        autoAdvance: false,
      });
      // Simulate the operator already having merged manually, but resolving
      // a conflict by keeping main's "ready" task file. Setup: bump main
      // with an edit to the same task file (forces a real conflict on
      // merge), then merge with `-X ours` which resolves by keeping main's
      // version. The run branch is now an ancestor of main (mergeIntoMain
      // will report alreadyMerged on approve), but the task status on main
      // is still "ready" — the post-merge helper must reconcile it.
      const taskFilePath = path.join(
        seed.workdirPath,
        ".factory",
        "work",
        `${seed.taskId}-demo.md`,
      );
      await writeFile(
        taskFilePath,
        `---\nid: ${seed.taskId}\ntitle: demo\nstatus: ready\nnote: edited on main\n---\n\nbody\n`,
        "utf8",
      );
      await git(["add", "-A"], seed.workdirPath);
      await git(["commit", "-q", "-m", "tweak task on main"], seed.workdirPath);
      await git(
        ["merge", "--no-ff", "-m", `merge ${seed.branch} (manual)`, "-X", "ours", seed.branch],
        seed.workdirPath,
      );
      const stale = await Bun.file(taskFilePath).text();
      expect(stale).toContain("status: ready");

      await h.caller.action({ decisionId: seed.decisionId, action: "approve" });

      const reconciled = await Bun.file(
        path.join(seed.workdirPath, ".factory", "work", `${seed.taskId}-demo.md`),
      ).text();
      expect(reconciled).toContain("status: done");
    } finally {
      h.cleanup();
    }
  });

  test("auto-advance skips when another run is already queued for the project", async () => {
    const h = setupHarness();
    try {
      const seed = await seedProjectWithCompletedRun(h, {
        initialTaskStatus: "ready",
        withNextReadyTask: true,
        autoAdvance: true,
      });

      // Operator already submitted a follow-up run manually between the
      // merge failure and decision approval — the helper must not double-
      // submit on top of it.
      const preexistingRunId = createId();
      h.db
        .insert(schema.runs)
        .values({
          id: preexistingRunId,
          projectId: seed.projectId,
          taskId: "task-008",
          status: "queued",
          agentName: "claude-code",
          branch: `factory/run-${preexistingRunId}`,
          worktreePath: path.join(h.root, "worktrees", "merge-approve-demo", preexistingRunId),
          startedAt: Date.now(),
          budgetSeconds: 0,
        })
        .run();

      await h.caller.action({ decisionId: seed.decisionId, action: "approve" });

      // Only the one pre-existing run for task-008 — helper did not double-submit.
      const task008Runs = h.db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.projectId, seed.projectId), eq(schema.runs.taskId, "task-008")))
        .all();
      expect(task008Runs.length).toBe(1);
      expect(task008Runs[0]?.id).toBe(preexistingRunId);
    } finally {
      h.cleanup();
    }
  });
});

describe("applyPostMergeRunOutcome · idempotency", () => {
  test("no-op when task on main is already in the target status", async () => {
    const h = setupHarness();
    try {
      // Seed a project where main already has the task in done state and
      // there's no next ready task — helper should write nothing and queue
      // nothing.
      const seed = await seedProjectWithCompletedRun(h, {
        initialTaskStatus: "ready",
        autoAdvance: true,
      });
      await git(["merge", "--no-ff", "-m", `merge ${seed.branch}`, seed.branch], seed.workdirPath);

      // Snapshot HEAD so we can verify no new commit was created.
      const beforeHead = (await git(["rev-parse", "HEAD"], seed.workdirPath)).stdout.trim();
      const runsBefore = h.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.projectId, seed.projectId))
        .all().length;

      await applyPostMergeRunOutcome(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        seed.runId,
      );

      const afterHead = (await git(["rev-parse", "HEAD"], seed.workdirPath)).stdout.trim();
      const runsAfter = h.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.projectId, seed.projectId))
        .all().length;
      expect(afterHead).toBe(beforeHead);
      // No next ready task seeded → no new run.
      expect(runsAfter).toBe(runsBefore);
    } finally {
      h.cleanup();
    }
  });
});
