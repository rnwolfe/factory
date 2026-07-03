import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { runtime } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";

import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { WorkerPool } from "../src/workers/pool.ts";
// The real module — the mock below overrides only `applyPostMergeRunOutcome`
// while preserving every other export (taskStatusFor, …), and `afterAll`
// restores it so the swap can't leak into sibling test files.
import * as postMergeReal from "../src/workers/post-merge.ts";
import { RunRegistry } from "../src/workers/registry.ts";

/**
 * Regression guard for the phantom-`failed`-on-a-merged-run bug: the runner's
 * finalize pipeline used to run every post-merge side effect inside the same
 * `try` whose `catch` marks the run `failed`. So if auto-advance (or any other
 * post-merge step) threw AFTER the run's branch had already merged to main, the
 * catch overwrote an already-`completed`, already-merged run as `failed` —
 * wrongly contracting the trust ladder (ADR-012) and polluting the autonomy
 * failure metrics (ADR-013).
 *
 * These tests drive the real `executeRun` with a faked agent spawn + a real git
 * merge, then force the post-merge side effect to throw and assert the run row
 * stays `completed` and the failure is surfaced (not swallowed, not fatal).
 */

const AUTO_ADVANCE_ERROR = "boom: auto-advance submit failed";

// Capture the REAL function now, before any mock is installed. The
// `postMergeReal` namespace live-binds to the current module export, so after
// mock.module runs it would itself point at the throwing stub — restoring via
// the namespace alone would re-apply the mock. Holding the original reference
// lets `afterAll` put the genuine implementation back so the swap can't leak
// into sibling test files (which import the real applyPostMergeRunOutcome).
const realApplyPostMergeRunOutcome = postMergeReal.applyPostMergeRunOutcome;

// Force auto-advance to throw AFTER the merge. runner.ts imports
// applyPostMergeRunOutcome by name; mock.module updates that live binding.
beforeAll(() => {
  mock.module("../src/workers/post-merge.ts", () => ({
    ...postMergeReal,
    applyPostMergeRunOutcome: async () => {
      throw new Error(AUTO_ADVANCE_ERROR);
    },
  }));
});
afterAll(() => {
  mock.module("../src/workers/post-merge.ts", () => ({
    ...postMergeReal,
    applyPostMergeRunOutcome: realApplyPostMergeRunOutcome,
  }));
});

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
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-postmerge-guard-"));
  const dbPath = path.join(root, "data.db");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(path.join(root, "projects"), { recursive: true });
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
    runs: new RunRegistry(),
    pool: new WorkerPool(1),
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

/**
 * A real git project whose run branch (in a real linked worktree) is one commit
 * ahead of main, so the runner's real `mergeIntoMain` lands cleanly.
 */
async function seedCompletableRun(h: Harness): Promise<Seed> {
  const slug = "postmerge-demo";
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
  // One "agent work" commit on the run branch, so the merge is a real advance.
  await writeFile(path.join(worktreePath, "feature.md"), "# feature\n", "utf8");
  await git(["add", "-A"], worktreePath);
  await git(["commit", "-q", "-m", "feat: feature"], worktreePath);

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
      // Off so nothing else contends; the mocked auto-advance throws regardless.
      autoAdvance: false,
      model: null,
      archivedAt: null,
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

/** The footer the runner parses to decide the terminal status. */
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

/**
 * Spy the runtime spawn so no real agent/tmux runs: emit the done footer via
 * onEvent (how agentText accumulates) and return a clean, committed result.
 */
function fakeCleanSpawn(seed: Seed) {
  return spyOn(runtime, "spawn").mockImplementation(async (spec) => {
    spec.onEvent({
      kind: "text",
      text: DONE_FOOTER,
      final: true,
      runId: seed.runId,
      iteration: 1,
    });
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

describe("executeRun · post-merge side-effect isolation", () => {
  test("auto-advance throwing after a successful merge leaves the run completed", async () => {
    const h = setupHarness();
    const seed = await seedCompletableRun(h);
    const spawnSpy = fakeCleanSpawn(seed);
    try {
      const { executeRun } = await import("../src/workers/runner.ts");

      // Must NOT reject: the run finalized; the post-merge throw is isolated.
      await executeRun(
        { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
        seed.runId,
      );

      // The run stayed completed — no phantom `failed`.
      const run = h.db.select().from(schema.runs).where(eq(schema.runs.id, seed.runId)).get();
      expect(run?.status).toBe("completed");

      // The merge actually happened (feature.md is on main).
      const onMain = await git(["cat-file", "-e", "HEAD:feature.md"], seed.workdirPath);
      expect(onMain.exitCode).toBe(0);

      // The failure was surfaced, not swallowed: a side_effect_failed autonomy
      // event names the auto-advance step.
      const autonomy = h.db
        .select()
        .from(schema.autonomyEvents)
        .where(eq(schema.autonomyEvents.runId, seed.runId))
        .all();
      const sideEffect = autonomy.find((e) => e.kind === "side_effect_failed");
      expect(sideEffect).toBeTruthy();
      expect(sideEffect?.message).toContain("auto-advance");
    } finally {
      spawnSpy.mockRestore();
      h.cleanup();
    }
  });

  test("a genuine mid-run failure (spawn throws) still marks the run failed", async () => {
    const h = setupHarness();
    const seed = await seedCompletableRun(h);
    const spawnSpy = spyOn(runtime, "spawn").mockImplementation(async () => {
      throw new Error("spawn exploded before any status was written");
    });
    try {
      const { executeRun } = await import("../src/workers/runner.ts");

      let threw: unknown;
      try {
        await executeRun(
          { config: h.config, db: h.db, events: h.events, runs: h.runs, pool: h.pool },
          seed.runId,
        );
      } catch (e) {
        threw = e;
      }
      // Pre-finalization failures must still reject AND mark the run failed.
      expect(threw).toBeInstanceOf(Error);
      const run = h.db.select().from(schema.runs).where(eq(schema.runs.id, seed.runId)).get();
      expect(run?.status).toBe("failed");
    } finally {
      spawnSpy.mockRestore();
      h.cleanup();
    }
  });
});
