import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { runtime } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, eq } from "drizzle-orm";

import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { EventBus } from "../src/events.ts";
import { decisionsRouter } from "../src/routers/decisions.ts";
import { ScriptRegistry } from "../src/scripts/registry.ts";
import { createCallerFactory } from "../src/trpc.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Merge remediation (feature plan mnx1zt27): when a run's auto-merge to `main`
 * fails because `main` was dirty, the `mergeRemediation.dirtyAutoReset` lever
 * governs whether the daemon resets `main` and retries unattended (`true`) or
 * surfaces a one-tap "Reset main & retry" operator action (`false`). These
 * tests drive the real `executeRun` with a faked agent spawn against a real git
 * repo whose `main` is deliberately dirty, exercising both lever states end to
 * end plus the "reset+retry still fails → stays pending" fallback.
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
  runs: RunRegistry;
  pool: WorkerPool;
  caller: ReturnType<typeof createCaller>;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-merge-remediation-"));
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
  const ctx: DaemonContext = {
    db,
    events,
    runs,
    pool,
    config,
    scripts: new ScriptRegistry(events),
    authorized: true,
  };
  return {
    config,
    db,
    events,
    runs,
    pool,
    caller: createCaller(ctx),
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

interface Seed {
  projectId: string;
  workdirPath: string;
  runId: string;
  branch: string;
  worktreePath: string;
}

interface SeedOpts {
  /** JSON stored on projects.autonomy_config (governs dirtyAutoReset). */
  autonomyConfig?: string;
  /**
   * When set, main gets its own committed `feature.md` so the run branch's
   * add of the same file conflicts — the reset+retry still fails.
   */
  conflictOnMain?: boolean;
}

/**
 * A real git project whose run branch (in a real linked worktree) adds
 * `feature.md`, plus a dirty (untracked) file on `main` so the runner's real
 * `mergeIntoMain` refuses with `reason: "dirty"`.
 */
async function seedDirtyMergeRun(h: Harness, opts: SeedOpts = {}): Promise<Seed> {
  const slug = "remediation-demo";
  const projectId = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });
  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);
  await writeFile(path.join(workdirPath, "README.md"), "# init\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "init"], workdirPath);

  const runId = createId();
  const branch = `factory/run-${runId}`;
  const worktreePath = path.join(h.root, "worktrees", slug, runId);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  await git(["worktree", "add", "-q", "-b", branch, worktreePath, "main"], workdirPath);
  // One "agent work" commit on the run branch.
  await writeFile(path.join(worktreePath, "feature.md"), "# feature (branch)\n", "utf8");
  await git(["add", "-A"], worktreePath);
  await git(["commit", "-q", "-m", "feat: feature"], worktreePath);

  if (opts.conflictOnMain) {
    // A committed, divergent feature.md on main → add/add conflict that a
    // reset can't clear (it's committed, not dirty).
    await writeFile(path.join(workdirPath, "feature.md"), "# feature (main)\n", "utf8");
    await git(["add", "-A"], workdirPath);
    await git(["commit", "-q", "-m", "chore: main feature"], workdirPath);
  }

  // Dirty main: an untracked file → mergeIntoMain reports reason "dirty".
  await writeFile(path.join(workdirPath, "scratch.tmp"), "leftover cruft\n", "utf8");

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
      autonomyConfig: opts.autonomyConfig ?? null,
    })
    .run();

  h.db
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      taskId: null,
      status: "queued",
      agentName: "claude-code",
      branch,
      worktreePath,
      startedAt: now,
      budgetSeconds: 0,
    })
    .run();

  return { projectId, workdirPath, runId, branch, worktreePath };
}

const DONE_FOOTER = [
  "All set.",
  "",
  "```factory-status",
  JSON.stringify({
    status: "done",
    summary: "did the work",
    acceptance: [{ criterion: "it works", met: true, evidence: "feature.md" }],
  }),
  "```",
].join("\n");

/** Fake the runtime spawn: emit the done footer and return a clean result. */
function fakeCleanSpawn(seed: Seed) {
  return spyOn(runtime, "spawn").mockImplementation(async (spec) => {
    spec.onEvent({ kind: "text", text: DONE_FOOTER, final: true, runId: seed.runId, iteration: 1 });
    return {
      runId: seed.runId,
      branch: seed.branch,
      worktreePath: seed.worktreePath,
      commits: [{ sha: "deadbeef", subject: "feat: feature" }],
      sessionId: "sess-1",
      exitCode: 0,
      iterationsCompleted: 1,
    };
  });
}

function onMain(workdirPath: string): Promise<boolean> {
  return git(["cat-file", "-e", "HEAD:feature.md"], workdirPath).then((r) => r.exitCode === 0);
}

describe("merge remediation · dirtyAutoReset lever", () => {
  test("lever true → runner resets main and merges unattended, no operator tap", async () => {
    const h = setupHarness();
    const seed = await seedDirtyMergeRun(h, {
      autonomyConfig: JSON.stringify({ mergeRemediation: { dirtyAutoReset: true } }),
    });
    const spawnSpy = fakeCleanSpawn(seed);
    try {
      const { executeRun } = await import("../src/workers/runner.ts");
      await executeRun(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        seed.runId,
      );

      // The run completed and the branch merged: feature.md is on main and the
      // dirty scratch file was cleaned away by the reset.
      const run = h.db.select().from(schema.runs).where(eq(schema.runs.id, seed.runId)).get();
      expect(run?.status).toBe("completed");
      expect(await onMain(seed.workdirPath)).toBe(true);

      // No pending decision — nothing landed in the inbox for the operator.
      const pending = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.status, "pending"),
          ),
        )
        .all();
      expect(pending.length).toBe(0);

      // An already-resolved merge_failure decision exists for the audit trail.
      const resolved = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.kind, "merge_failure"),
          ),
        )
        .all();
      expect(resolved.length).toBe(1);
      expect(resolved[0]?.status).toBe("actioned");
      expect(resolved[0]?.outcome).toBe("merge:dirty-auto-reset");

      // No tmux/intervention session was created.
      const interventions = h.db
        .select()
        .from(schema.interventions)
        .where(eq(schema.interventions.projectId, seed.projectId))
        .all();
      expect(interventions.length).toBe(0);

      // An auto_merged autonomy event records the unattended action.
      const autonomy = h.db
        .select()
        .from(schema.autonomyEvents)
        .where(eq(schema.autonomyEvents.runId, seed.runId))
        .all();
      expect(autonomy.some((e) => e.kind === "auto_merged")).toBe(true);
    } finally {
      spawnSpy.mockRestore();
      h.cleanup();
    }
  });

  test("lever false → decision stays pending until operator taps resolveMergeFailureDirty", async () => {
    const h = setupHarness();
    // Default config → dirtyAutoReset false.
    const seed = await seedDirtyMergeRun(h);
    const spawnSpy = fakeCleanSpawn(seed);
    try {
      const { executeRun } = await import("../src/workers/runner.ts");
      await executeRun(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        seed.runId,
      );

      // The merge did NOT happen automatically — a pending decision surfaced.
      expect(await onMain(seed.workdirPath)).toBe(false);
      const pending = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.status, "pending"),
            eq(schema.decisions.kind, "merge_failure"),
          ),
        )
        .all();
      expect(pending.length).toBe(1);
      const decisionId = pending[0]?.id ?? "";
      expect((pending[0]?.payload as { reason?: string }).reason).toBe("dirty");

      // Operator taps "reset main & retry".
      const res = await h.caller.resolveMergeFailureDirty({ decisionId });
      expect(res.ok).toBe(true);
      expect(res.mergedSha).toBeTruthy();

      // Now the merge landed and the decision is actioned.
      expect(await onMain(seed.workdirPath)).toBe(true);
      const after = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(after?.status).toBe("actioned");

      // The tap did not spin up a tmux intervention.
      const interventions = h.db
        .select()
        .from(schema.interventions)
        .where(eq(schema.interventions.projectId, seed.projectId))
        .all();
      expect(interventions.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
      h.cleanup();
    }
  });

  test("lever true but reset+retry still conflicts → falls through to a pending decision", async () => {
    const h = setupHarness();
    const seed = await seedDirtyMergeRun(h, {
      autonomyConfig: JSON.stringify({ mergeRemediation: { dirtyAutoReset: true } }),
      conflictOnMain: true,
    });
    const spawnSpy = fakeCleanSpawn(seed);
    try {
      const { executeRun } = await import("../src/workers/runner.ts");
      await executeRun(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        seed.runId,
      );

      // Reset cleared the dirt but the committed conflict remains → the merge
      // still fails, so a normal pending decision surfaces (tmux fallback).
      const pending = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.status, "pending"),
            eq(schema.decisions.kind, "merge_failure"),
          ),
        )
        .all();
      expect(pending.length).toBe(1);
      // No auto-resolved audit decision was recorded.
      const resolved = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.status, "actioned"),
          ),
        )
        .all();
      expect(resolved.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
      h.cleanup();
    }
  });

  test("operator tap when reset+retry still conflicts → throws, decision stays pending", async () => {
    const h = setupHarness();
    const seed = await seedDirtyMergeRun(h, { conflictOnMain: true });
    const spawnSpy = fakeCleanSpawn(seed);
    try {
      const { executeRun } = await import("../src/workers/runner.ts");
      await executeRun(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        seed.runId,
      );
      const pending = h.db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, seed.projectId),
            eq(schema.decisions.status, "pending"),
          ),
        )
        .get();
      const decisionId = pending?.id ?? "";

      let threw: unknown;
      try {
        await h.caller.resolveMergeFailureDirty({ decisionId });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(Error);

      // Decision remains pending; the tmux-intervention fallback is intact
      // (no intervention was auto-created by the failed tap).
      const still = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(still?.status).toBe("pending");
      const interventions = h.db
        .select()
        .from(schema.interventions)
        .where(eq(schema.interventions.projectId, seed.projectId))
        .all();
      expect(interventions.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
      h.cleanup();
    }
  });
});
