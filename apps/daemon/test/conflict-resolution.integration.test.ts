import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
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
import { remediateMergeConflict } from "../src/workers/resolve-conflict.ts";

/**
 * Conflict auto-resolve (feature plan mnx1zt27): the conflict sibling of the
 * dirtyAutoReset lever. When a run's auto-merge to `main` conflicts, an agent
 * resolves it in an isolated scratch worktree; the `conflictAutoResolve` lever
 * decides whether a valid resolution lands unattended (`true`) or is surfaced as
 * a *proposed* resolution the operator taps to apply (`false`). These tests drive
 * `remediateMergeConflict` against a real git repo with a synthetic two-file
 * conflict, using an injected agent-invoker that performs the real resolution.
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
  const root = mkdtempSync(path.join(tmpdir(), "factory-conflict-resolve-"));
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
}

/**
 * A real git project where BOTH `main` and the run branch diverge on the same two
 * files (`a.txt`, `b.txt`) from a shared base — so `mergeIntoMain` conflicts on
 * both. Main is clean and checked out on `main` (so the failure mode is
 * `conflict`, not `dirty`).
 */
async function seedConflictingRun(h: Harness, autonomyConfig?: string): Promise<Seed> {
  const slug = "conflict-demo";
  const projectId = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });
  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);
  await writeFile(path.join(workdirPath, "a.txt"), "base-a\n", "utf8");
  await writeFile(path.join(workdirPath, "b.txt"), "base-b\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "base"], workdirPath);

  const runId = createId();
  const branch = `factory/run-${runId}`;
  // Run branch: diverge both files.
  await git(["checkout", "-q", "-b", branch], workdirPath);
  await writeFile(path.join(workdirPath, "a.txt"), "branch-a\n", "utf8");
  await writeFile(path.join(workdirPath, "b.txt"), "branch-b\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "feat: branch changes"], workdirPath);

  // Back on main: diverge the same two files differently → add/add conflict.
  await git(["checkout", "-q", "main"], workdirPath);
  await writeFile(path.join(workdirPath, "a.txt"), "main-a\n", "utf8");
  await writeFile(path.join(workdirPath, "b.txt"), "main-b\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "chore: main changes"], workdirPath);

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
      autonomyConfig: autonomyConfig ?? null,
    })
    .run();

  h.db
    .insert(schema.runs)
    .values({
      id: runId,
      projectId,
      taskId: null,
      status: "completed",
      agentName: "claude-code",
      branch,
      worktreePath: path.join(h.root, "worktrees", slug, runId),
      startedAt: now,
      budgetSeconds: 0,
    })
    .run();

  return { projectId, workdirPath, runId, branch };
}

/** True if `main` now has the union resolution the fake agent produces. */
async function mainResolved(workdirPath: string): Promise<boolean> {
  const head = await git(["symbolic-ref", "--short", "HEAD"], workdirPath);
  if (head.stdout.trim() !== "main") return false;
  const a = await git(["show", "HEAD:a.txt"], workdirPath);
  return a.stdout.includes("main-a") && a.stdout.includes("branch-a");
}

/**
 * Fake resolution agent: resolves both conflicts in the scratch worktree by
 * unioning the two sides, `git add`s, completes the merge, and returns a `done`
 * status block. Exercises the real prepare → agent → finalize → land pipeline.
 */
function unionResolver(commit: boolean) {
  return async (_prompt: string, cwd: string): Promise<string> => {
    for (const f of ["a.txt", "b.txt"]) {
      const raw = await readFile(path.join(cwd, f), "utf8");
      // Strip conflict markers, keeping both sides' payload lines.
      const kept = raw
        .split("\n")
        .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l))
        .join("\n");
      await writeFile(path.join(cwd, f), kept, "utf8");
      await git(["add", f], cwd);
    }
    if (commit) {
      await git(["commit", "--no-edit", "--no-verify"], cwd);
    }
    return [
      "Resolved both files by keeping both sides.",
      "```factory-status",
      JSON.stringify({
        status: "done",
        summary: "Unioned main and branch edits in a.txt and b.txt.",
        files_resolved: ["a.txt", "b.txt"],
      }),
      "```",
    ].join("\n");
  };
}

describe("conflict auto-resolve · conflictAutoResolve lever", () => {
  test("lever true → agent resolves and merges without a tap; decision resolves automatically", async () => {
    const h = setupHarness();
    const seed = await seedConflictingRun(
      h,
      JSON.stringify({ mergeRemediation: { conflictAutoResolve: true } }),
    );
    try {
      const outcome = await remediateMergeConflict(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          projectId: seed.projectId,
          runId: seed.runId,
          taskId: null,
          branch: seed.branch,
          mergeMessage: "merge failed: conflict",
        },
        { agentInvoker: unionResolver(true) },
      );

      expect(outcome.handled).toBe(true);
      expect(outcome.handled && outcome.landed).toBe(true);
      expect(await mainResolved(seed.workdirPath)).toBe(true);

      // No pending decision — nothing landed in the inbox.
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

      // An already-resolved merge_failure decision records the audit trail.
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
      expect(resolved[0]?.outcome).toBe("merge:conflict-auto-resolved");

      // An auto_merged autonomy event records the unattended action.
      const autonomy = h.db
        .select()
        .from(schema.autonomyEvents)
        .where(eq(schema.autonomyEvents.runId, seed.runId))
        .all();
      expect(autonomy.some((e) => e.kind === "auto_merged")).toBe(true);

      // The resolve branch was cleaned up after landing.
      const branchExists = await git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/factory/resolve-${seed.runId}`],
        seed.workdirPath,
      );
      expect(branchExists.exitCode).not.toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("lever false → decision stays pending with a proposed resolution until approved, then merges identically", async () => {
    const h = setupHarness();
    // Default config → conflictAutoResolve false.
    const seed = await seedConflictingRun(h);
    try {
      const outcome = await remediateMergeConflict(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          projectId: seed.projectId,
          runId: seed.runId,
          taskId: null,
          branch: seed.branch,
          mergeMessage: "merge failed: conflict",
        },
        { agentInvoker: unionResolver(true) },
      );

      expect(outcome.handled).toBe(true);
      expect(outcome.handled && outcome.landed).toBe(false);
      // Main did NOT move yet — awaiting the operator's tap.
      expect(await mainResolved(seed.workdirPath)).toBe(false);

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
      const decision = pending[0];
      const payload = decision?.payload as {
        reason?: string;
        proposedResolution?: { resolveBranch: string; resolutionSha: string };
      };
      expect(payload.reason).toBe("conflict");
      expect(payload.proposedResolution?.resolveBranch).toBe(`factory/resolve-${seed.runId}`);
      expect(payload.proposedResolution?.resolutionSha).toBeTruthy();

      // Operator taps "apply resolution & merge".
      const res = await h.caller.resolveMergeFailureConflict({ decisionId: decision?.id ?? "" });
      expect(res.ok).toBe(true);
      expect(res.mergedSha).toBeTruthy();

      // Now main carries the identical resolution and the decision is actioned.
      expect(await mainResolved(seed.workdirPath)).toBe(true);
      const after = h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decision?.id ?? ""))
        .get();
      expect(after?.status).toBe("actioned");
      expect(after?.outcome).toBe("merge:conflict-resolved");
    } finally {
      h.cleanup();
    }
  });

  test("agent auto-commit optional: finalize completes an uncommitted-but-resolved merge", async () => {
    const h = setupHarness();
    const seed = await seedConflictingRun(
      h,
      JSON.stringify({ mergeRemediation: { conflictAutoResolve: true } }),
    );
    try {
      // Resolver stages the resolution but does NOT commit — finalize must
      // complete the merge itself.
      const outcome = await remediateMergeConflict(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          projectId: seed.projectId,
          runId: seed.runId,
          taskId: null,
          branch: seed.branch,
          mergeMessage: "merge failed: conflict",
        },
        { agentInvoker: unionResolver(false) },
      );
      expect(outcome.handled && outcome.landed).toBe(true);
      expect(await mainResolved(seed.workdirPath)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("null-parsed / non-done completion → not handled, decision stays for the tmux fallback", async () => {
    const h = setupHarness();
    const seed = await seedConflictingRun(
      h,
      JSON.stringify({ mergeRemediation: { conflictAutoResolve: true } }),
    );
    try {
      // Agent emits no parseable status block → null-parse → fail.
      const nullResolver = async (_p: string, _cwd: string) => "I could not figure this out.";
      const outcome = await remediateMergeConflict(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          projectId: seed.projectId,
          runId: seed.runId,
          taskId: null,
          branch: seed.branch,
          mergeMessage: "merge failed: conflict",
        },
        { agentInvoker: nullResolver },
      );

      // Not handled → the runner records the plain pending decision (tmux
      // fallback). A `true` lever did NOT force a merge through.
      expect(outcome.handled).toBe(false);
      expect(await mainResolved(seed.workdirPath)).toBe(false);

      // No resolved audit decision, no auto_merged event.
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
      const autonomy = h.db
        .select()
        .from(schema.autonomyEvents)
        .where(eq(schema.autonomyEvents.runId, seed.runId))
        .all();
      expect(autonomy.some((e) => e.kind === "auto_merged")).toBe(false);

      // The scratch resolve branch was cleaned up on the failed produce.
      const branchExists = await git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/factory/resolve-${seed.runId}`],
        seed.workdirPath,
      );
      expect(branchExists.exitCode).not.toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("agent reports blocked → not handled, no merge forced", async () => {
    const h = setupHarness();
    const seed = await seedConflictingRun(
      h,
      JSON.stringify({ mergeRemediation: { conflictAutoResolve: true } }),
    );
    try {
      const blockedResolver = async (_p: string, _cwd: string) =>
        [
          "```factory-status",
          JSON.stringify({ status: "blocked", summary: "ambiguous" }),
          "```",
        ].join("\n");
      const outcome = await remediateMergeConflict(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        {
          projectId: seed.projectId,
          runId: seed.runId,
          taskId: null,
          branch: seed.branch,
          mergeMessage: "merge failed: conflict",
        },
        { agentInvoker: blockedResolver },
      );
      expect(outcome.handled).toBe(false);
      expect(await mainResolved(seed.workdirPath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
