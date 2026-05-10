import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import {
  cancelDeferredTask,
  DeferredTaskNotFoundError,
  recoverOrphanedDeferredTasks,
  spawnDeferredTask,
} from "../src/deferred-tasks/orchestrate.ts";
import { EventBus } from "../src/events.ts";
import type { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Pool stub: accepts submissions but never executes them. The orchestrator
 * fire-and-forgets executeRun on the real pool; calling the real executeRun
 * here would try to spawn a real claude binary and tmux session. We only
 * need to verify the run row is inserted and continuationRunId is wired up.
 */
function noopPool(): WorkerPool {
  return {
    submit: () => Promise.resolve(),
    drain: async () => {},
    size: () => ({ active: 0, queued: 0 }),
    concurrency: 0,
  } as unknown as WorkerPool;
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

async function git(args: string[], cwd: string): Promise<{ exitCode: number }> {
  const p = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await p.exited };
}

async function setupHarness(): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-deferred-test-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
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
    gitAuthor: { name: "test", email: "t@t" },
    githubToken: null,
    factoryProjectId: null,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  return {
    config,
    db,
    events,
    runs: new RunRegistry(),
    pool: noopPool(),
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

interface SeedResult {
  projectId: string;
  runId: string;
  worktreePath: string;
  branch: string;
}

/**
 * Build a real git-initialized project + a `factory/run-X` worktree that's
 * a sibling branch on it. The deferred-task completion path runs
 * `commitAllChanges` against this worktree, so it has to be a real git
 * repo or the auto-commit step silently no-ops.
 */
async function seedProjectAndRun(h: Harness, slug = "demo"): Promise<SeedResult> {
  const projectId = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });
  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);
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
      autoAdvance: false,
      model: null,
      archivedAt: null,
    })
    .run();

  const runId = createId();
  const branch = `factory/run-${runId}`;
  const worktreePath = path.join(h.root, "worktrees", slug, runId);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  await git(["worktree", "add", "-b", branch, worktreePath, "main"], workdirPath);

  h.db
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      taskId: null,
      status: "deferred",
      agentName: "claude-code",
      branch,
      worktreePath,
      startedAt: now,
      endedAt: now + 1000,
      budgetSeconds: 60,
      summary: "deferred for long build",
    })
    .run();

  return { projectId, runId, worktreePath, branch };
}

describe("deferred-tasks orchestrate", () => {
  test("spawnDeferredTask inserts a row, runs the command, and writes to the log", async () => {
    const h = await setupHarness();
    try {
      const seed = await seedProjectAndRun(h);
      const { deferredTaskId, logPath } = await spawnDeferredTask(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          id: seed.runId,
          projectId: seed.projectId,
          taskId: null,
          worktreePath: seed.worktreePath,
          branch: seed.branch,
        },
        {
          command: "printf 'hello defer\\n'",
          summary: "smoke test",
          continuation: "verify hello was printed",
        },
      );
      expect(deferredTaskId).toBeTruthy();
      expect(logPath).toContain(".factory/runs");

      const row = h.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.id, deferredTaskId))
        .get();
      expect(row?.status).toBe("running");
      expect(row?.command).toBe("printf 'hello defer\\n'");
      expect(row?.summary).toBe("smoke test");
      expect(row?.pid).toBeGreaterThan(0);

      // Wait for completion handler to run; cap at a few seconds so the
      // test doesn't hang if the orchestrator regresses.
      await waitFor(
        () => {
          const r = h.db
            .select({ status: schema.deferredTasks.status, exit: schema.deferredTasks.exitCode })
            .from(schema.deferredTasks)
            .where(eq(schema.deferredTasks.id, deferredTaskId))
            .get();
          return r?.status === "completed";
        },
        { timeoutMs: 5_000, label: "deferred completed" },
      );
      const finalRow = h.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.id, deferredTaskId))
        .get();
      expect(finalRow?.exitCode).toBe(0);

      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("hello defer");
    } finally {
      h.cleanup();
    }
  });

  test("on completion, a continuation run is submitted reusing the source worktree", async () => {
    const h = await setupHarness();
    try {
      const seed = await seedProjectAndRun(h);
      const { deferredTaskId } = await spawnDeferredTask(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          id: seed.runId,
          projectId: seed.projectId,
          taskId: null,
          worktreePath: seed.worktreePath,
          branch: seed.branch,
        },
        {
          command: "true",
          summary: "build the M21 corpus",
          continuation: "Verify chunks fall under 200 tokens; report counts.",
        },
      );

      // Wait for the continuation submit step.
      await waitFor(
        () => {
          const r = h.db
            .select({ continuationRunId: schema.deferredTasks.continuationRunId })
            .from(schema.deferredTasks)
            .where(eq(schema.deferredTasks.id, deferredTaskId))
            .get();
          return Boolean(r?.continuationRunId);
        },
        { timeoutMs: 5_000, label: "continuation submitted" },
      );
      const finalRow = h.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.id, deferredTaskId))
        .get();
      expect(finalRow?.continuationRunId).toBeTruthy();

      const continuationRun = h.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, finalRow?.continuationRunId ?? ""))
        .get();
      // Reuses the source worktree + branch so gitignored build output stays
      // accessible to the resumed agent.
      expect(continuationRun?.worktreePath).toBe(seed.worktreePath);
      expect(continuationRun?.branch).toBe(seed.branch);
      expect(continuationRun?.operatorContext ?? "").toContain("Deferred task continuation");
      expect(continuationRun?.operatorContext ?? "").toContain("build the M21 corpus");
      expect(continuationRun?.operatorContext ?? "").toContain(
        "Verify chunks fall under 200 tokens",
      );
      expect(continuationRun?.operatorContext ?? "").toContain("Exit code: 0");
    } finally {
      h.cleanup();
    }
  });

  test("cancelDeferredTask SIGTERMs the subprocess and marks cancelled", async () => {
    const h = await setupHarness();
    try {
      const seed = await seedProjectAndRun(h);
      const { deferredTaskId } = await spawnDeferredTask(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          id: seed.runId,
          projectId: seed.projectId,
          taskId: null,
          worktreePath: seed.worktreePath,
          branch: seed.branch,
        },
        {
          // Long-running so we can race a cancel against it.
          command: "sleep 30",
          summary: "long-running",
          continuation: "(unused)",
        },
      );
      const result = await cancelDeferredTask(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        deferredTaskId,
      );
      expect(result.ok).toBe(true);
      if (result.cancelled) {
        expect(result.pid).toBeGreaterThan(0);
      }
      const row = h.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.id, deferredTaskId))
        .get();
      expect(row?.status).toBe("cancelled");

      // The completion handler eventually fires (process killed). It must
      // NOT submit a continuation when the task was cancelled.
      await new Promise((r) => setTimeout(r, 800));
      const aft = h.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.id, deferredTaskId))
        .get();
      expect(aft?.continuationRunId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("cancelDeferredTask on a missing id throws DeferredTaskNotFoundError", async () => {
    const h = await setupHarness();
    try {
      let thrown: unknown;
      try {
        await cancelDeferredTask(
          { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
          "nonexistent",
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DeferredTaskNotFoundError);
    } finally {
      h.cleanup();
    }
  });

  test("recoverOrphanedDeferredTasks marks running rows as orphaned", async () => {
    const h = await setupHarness();
    try {
      const seed = await seedProjectAndRun(h);
      const id = createId();
      h.db
        .insert(schema.deferredTasks)
        .values({
          id,
          runId: seed.runId,
          projectId: seed.projectId,
          command: "sleep 9999",
          summary: "stale",
          continuationPrompt: "(unused)",
          logPath: "/dev/null",
          status: "running",
          pid: 999_999_999,
          startedAt: Date.now() - 60_000,
        })
        .run();
      const reaped = await recoverOrphanedDeferredTasks(h.db, h.events);
      expect(reaped).toBe(1);
      const row = h.db
        .select()
        .from(schema.deferredTasks)
        .where(eq(schema.deferredTasks.id, id))
        .get();
      expect(row?.status).toBe("orphaned");
      expect(row?.endedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

interface WaitOpts {
  timeoutMs: number;
  label: string;
}
async function waitFor(check: () => boolean | Promise<boolean>, opts: WaitOpts): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out: ${opts.label}`);
}
