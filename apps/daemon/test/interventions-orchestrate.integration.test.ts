import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import {
  cancelIntervention,
  InterventionError,
  resumeFromIntervention,
  startIntervention,
} from "../src/interventions/orchestrate.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Cover the operator-driven repair path. The most load-bearing
 * contracts under test:
 *
 *  - blocked_run intervene roots tmux at the source run's worktree
 *    (NOT a fresh one) — the agent was just there, that's the file
 *    state the operator needs to see.
 *  - merge_failure intervene roots tmux at the project's main workdir
 *    (NOT the run's worktree) — the merge failed in main, that's
 *    where the operator reconciles state.
 *  - resume(blocked_run) inserts a NEW run row with sessionId pre-set
 *    + resumes flag, threading the operator's thread replies + a
 *    summary of what changed during intervention as operatorContext.
 *  - resume(merge_failure) re-runs mergeIntoMain on the source
 *    branch, marks the decision actioned on success.
 *  - cancel leaves the decision pending, no new runs submitted.
 */

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  events: EventBus;
  published: DaemonEvent[];
  runs: RunRegistry;
  pool: WorkerPool;
  root: string;
  cleanup: () => void;
}

async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = bunSpawn({ cmd: ["tmux", "-V"], stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const p = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const code = await p.exited;
  return { exitCode: code, stdout };
}

async function setupHarness(): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-intervene-test-"));
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
    factoryProjectId: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  return {
    config,
    db,
    events,
    published,
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

async function seedProject(
  h: Harness,
  slug = "intervene-demo",
): Promise<{
  id: string;
  workdirPath: string;
}> {
  const id = createId();
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
      id,
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
  return { id, workdirPath };
}

async function seedBlockedRunWithDecision(
  h: Harness,
  projectId: string,
  workdirPath: string,
): Promise<{ runId: string; decisionId: string; runWorktree: string; branch: string }> {
  const runId = createId();
  const branch = `factory/run-${runId}`;
  const runWorktree = path.join(h.root, "worktrees", "intervene-demo", runId);
  mkdirSync(runWorktree, { recursive: true });
  // Create the worktree as a real git worktree on a new branch so the
  // intervention's auto-commit step has somewhere to land.
  await git(["checkout", "-b", branch], workdirPath);
  await git(["checkout", "main"], workdirPath);
  await git(["worktree", "add", "-q", runWorktree, branch], workdirPath);

  const sessionId = `claude-session-${runId.slice(0, 8)}`;
  const now = Date.now();
  h.db
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      taskId: "task-007",
      status: "blocked",
      agentName: "claude-code",
      branch,
      worktreePath: runWorktree,
      sessionId,
      startedAt: now - 60_000,
      endedAt: now - 1_000,
      budgetSeconds: 0,
      summary: "Blocked on M21 export path.",
      blockerQuestions: JSON.stringify(["Where is the export?"]),
    })
    .run();

  const decisionId = createId();
  h.db
    .insert(schema.decisions)
    .values({
      id: decisionId,
      kind: "blocked_run",
      projectId,
      outcome: "blocked",
      payload: {
        runId,
        taskId: "task-007",
        summary: "Blocked on M21 export path.",
        questions: ["Where is the export?"],
        branch,
      },
      status: "pending",
      createdAt: now,
    })
    .run();

  return { runId, decisionId, runWorktree, branch };
}

async function seedMergeFailureDecision(
  h: Harness,
  projectId: string,
  workdirPath: string,
): Promise<{ runId: string; decisionId: string; branch: string }> {
  // Make a real branch with a commit ahead of main so mergeIntoMain has
  // something to pull in on resume. Then dirty main so the merge would
  // currently fail.
  const runId = createId();
  const branch = `factory/run-${runId}`;
  await git(["checkout", "-b", branch], workdirPath);
  await writeFile(path.join(workdirPath, "feature.md"), "# feature\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "feature"], workdirPath);
  await git(["checkout", "main"], workdirPath);

  const decisionId = createId();
  const now = Date.now();
  h.db
    .insert(schema.decisions)
    .values({
      id: decisionId,
      kind: "merge_failure",
      projectId,
      outcome: "merge:failed",
      payload: {
        runId,
        branch,
        reason: "dirty",
        message: "main was dirty; merge aborted",
      },
      status: "pending",
      createdAt: now,
    })
    .run();
  return { runId, decisionId, branch };
}

describe("interventions orchestrate · blocked_run", () => {
  test("start roots tmux at the source run's worktree; cancel leaves decision pending", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const project = await seedProject(h);
      const { decisionId, runWorktree } = await seedBlockedRunWithDecision(
        h,
        project.id,
        project.workdirPath,
      );

      const started = await startIntervention(
        {
          config: h.config,
          db: h.db,
          events: h.events,
          runs: h.runs,
          pool: h.pool,
        },
        decisionId,
      );
      expect(started.decisionKind).toBe("blocked_run");
      expect(started.worktreePath).toBe(runWorktree);
      expect(started.tmuxSessionName).toMatch(/^factoryd-intervene-/);

      const row = h.db
        .select()
        .from(schema.interventions)
        .where(eq(schema.interventions.id, started.interventionId))
        .get();
      expect(row?.status).toBe("active");
      expect(row?.worktreePath).toBe(runWorktree);
      expect(row?.decisionKind).toBe("blocked_run");

      // A second start on the same decision must refuse — only one
      // active intervention per decision.
      let conflicted = false;
      try {
        await startIntervention(
          { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
          decisionId,
        );
      } catch (err) {
        conflicted = err instanceof InterventionError && err.code === "intervention_already_active";
      }
      expect(conflicted).toBe(true);

      await cancelIntervention(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        started.interventionId,
      );
      const cancelled = h.db
        .select()
        .from(schema.interventions)
        .where(eq(schema.interventions.id, started.interventionId))
        .get();
      expect(cancelled?.status).toBe("cancelled");

      const decision = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(decision?.status).toBe("pending");
    } finally {
      h.cleanup();
    }
  });

  test("resume submits a new run with resume:true, sessionId pre-set, and operator context", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const project = await seedProject(h);
      const { runId: sourceRunId, decisionId } = await seedBlockedRunWithDecision(
        h,
        project.id,
        project.workdirPath,
      );

      // An operator reply on the decision thread — the resume path
      // should fold this into the new run's operatorContext.
      h.db
        .insert(schema.decisionComments)
        .values({
          id: createId(),
          decisionId,
          role: "operator",
          body: "the export is at corpus/m21/raw/2026-04 export.zip — unzip and use the .pdf set.",
          createdAt: Date.now(),
        })
        .run();

      const started = await startIntervention(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        decisionId,
      );

      const result = await resumeFromIntervention(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        started.interventionId,
      );
      expect(result.newRunId).not.toBeNull();
      expect(result.mergedSha).toBeNull();

      const newRunId = result.newRunId as string;
      const newRun = h.db.select().from(schema.runs).where(eq(schema.runs.id, newRunId)).get();
      const sourceRun = h.db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, sourceRunId))
        .get();
      expect(newRun?.id).toBe(newRunId);
      // Resume mode requires sessionId on the row before runner.ts reads it.
      expect(newRun?.sessionId).toBe(`claude-session-${sourceRunId.slice(0, 8)}`);
      // The new run REUSES the source's worktree + branch — that's the
      // load-bearing fix. A fresh sibling worktree from source.branch
      // would lose the gitignored data the agent built up (corpus/,
      // .env*, build artifacts, node_modules), and the resumed agent
      // would boot into an empty workspace.
      expect(newRun?.worktreePath).toBe(sourceRun?.worktreePath);
      expect(newRun?.branch).toBe(sourceRun?.branch);
      // baseRef is meaningless on a reused worktree (already on branch).
      expect(newRun?.baseRef).toBeNull();
      // operatorContext carries forward the operator's thread reply + the
      // intervention summary so the resumed agent sees both layers.
      expect(newRun?.operatorContext).toContain("corpus/m21/raw/2026-04 export.zip");
      expect(newRun?.operatorContext).toContain("Operator intervention");

      // Intervention marked resumed; decision marked actioned.
      const intervention = h.db
        .select()
        .from(schema.interventions)
        .where(eq(schema.interventions.id, started.interventionId))
        .get();
      expect(intervention?.status).toBe("resumed");
      const decision = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(decision?.status).toBe("actioned");
      expect(decision?.actionedAt).toBeDefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("interventions orchestrate · merge_failure", () => {
  test("start roots tmux at project main workdir, NOT the run's worktree", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const project = await seedProject(h);
      const { decisionId } = await seedMergeFailureDecision(h, project.id, project.workdirPath);

      const started = await startIntervention(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        decisionId,
      );
      expect(started.decisionKind).toBe("merge_failure");
      expect(started.worktreePath).toBe(project.workdirPath);

      // Cleanup so we don't leak a tmux session.
      await cancelIntervention(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        started.interventionId,
      );
    } finally {
      h.cleanup();
    }
  });

  test("resume re-runs mergeIntoMain and marks the decision actioned on success", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const project = await seedProject(h);
      const { decisionId } = await seedMergeFailureDecision(h, project.id, project.workdirPath);

      const started = await startIntervention(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        decisionId,
      );

      // The merge_failure was synthetic — main is clean now so the
      // merge will succeed cleanly when resumed.
      const result = await resumeFromIntervention(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        started.interventionId,
      );
      expect(result.newRunId).toBeNull();
      expect(result.mergedSha).not.toBeNull();

      const decision = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(decision?.status).toBe("actioned");
    } finally {
      h.cleanup();
    }
  });
});
