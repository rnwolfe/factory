import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorktree, mergeIntoMain, removeWorktree } from "@factory/runtime";
import { spawn as bunSpawn } from "bun";

import { mergeLock } from "../src/workers/merge-lock.ts";

/**
 * Regression guard for the concurrent auto-merge collision. The worker pool
 * runs several runs at once and auto-advance chains them against one project,
 * so two runs against the same project used to reach the runner's merge-into-
 * main section at overlapping moments. Each independently drove git on the
 * project checkout; two git processes writing one repo collide on
 * `.git/index.lock` — the loser's `mergeIntoMain` returns a non-`ok` result and
 * a run that genuinely completed is surfaced as a merge failure instead of
 * landing on main.
 *
 * `runner.ts` now wraps the whole merge section in a per-project `mergeLock`
 * (merge-lock.ts). These tests exercise the SAME production lock singleton and
 * the SAME `mergeIntoMain` the runner uses, against real git repos:
 *   - same project → the two merges are strictly ordered, both commits land,
 *     no index.lock error, neither would be marked failed;
 *   - different projects → the merges still overlap in time (per-project keying,
 *     not a global serialization).
 */

const author = { name: "Test", email: "test@test.test" };

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
}

async function initRepo(dir: string): Promise<void> {
  await git(["init", "-q", "-b", "main"], dir);
  await Bun.write(path.join(dir, "base.txt"), "base\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "init"], dir);
}

/**
 * Create a run branch off the project's current HEAD holding one commit, then
 * tear the worktree down so only the ref remains — the exact shape the runner's
 * `mergeIntoMain` sees after a run finishes.
 */
async function makeRunBranch(
  project: string,
  root: string,
  branch: string,
  fileName: string,
): Promise<void> {
  const wt = path.join(root, `wt-${branch.replace(/\//g, "-")}`);
  await ensureWorktree({ projectPath: project, branch, worktreePath: wt });
  await Bun.write(path.join(wt, fileName), `${fileName}\n`);
  await git(["add", "-A"], wt);
  await git(["commit", "-q", "-m", `add ${fileName}`], wt);
  await removeWorktree({ projectPath: project, worktreePath: wt, force: true });
}

/** Reject after `ms` so a lock that never releases fails the test instead of hanging. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "merge-lock-race-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("mergeLock · concurrent auto-merge", () => {
  test("two same-project merges are serialized: both land on main, no index.lock error", async () => {
    const project = path.join(root, "repo");
    await Bun.write(path.join(project, ".keep"), "");
    await initRepo(project);
    await makeRunBranch(project, root, "factory/run-a", "a.txt");
    await makeRunBranch(project, root, "factory/run-b", "b.txt");

    const projectId = "proj-shared";
    // Observe how many merges are inside the critical section at once. Under the
    // per-project lock this never exceeds 1 — the second run's git work starts
    // only after the first's finishes, which is what prevents the index.lock
    // collision that used to spuriously fail a completed run.
    let active = 0;
    let maxActive = 0;

    async function mergeRun(branch: string) {
      return mergeLock.run(projectId, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          return await mergeIntoMain({
            projectPath: project,
            branch,
            message: `merge ${branch}`,
            author,
          });
        } finally {
          active--;
        }
      });
    }

    const [ra, rb] = await Promise.all([mergeRun("factory/run-a"), mergeRun("factory/run-b")]);

    // Neither merge collided — both landed cleanly. A collision would come back
    // ok:false with an `index.lock` / "another git process" message, which the
    // runner turns into a merge-failure / held run; surface it here if it fires.
    if (!ra.ok) throw new Error(`run-a merge failed: ${ra.reason}: ${ra.message}`);
    if (!rb.ok) throw new Error(`run-b merge failed: ${rb.reason}: ${rb.message}`);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    // The lock held the section to one merge at a time.
    expect(maxActive).toBe(1);

    // Both run branches' commits are now reachable from main.
    for (const branch of ["factory/run-a", "factory/run-b"]) {
      const anc = await git(["merge-base", "--is-ancestor", branch, "main"], project);
      expect(anc.exitCode).toBe(0);
    }
    // Both files landed on the project checkout.
    const files = await git(["ls-files"], project);
    expect(files.stdout).toContain("a.txt");
    expect(files.stdout).toContain("b.txt");
  });

  test("merges for two different projects overlap in time (per-project keying)", async () => {
    // Two independent project repos, each with one run branch to merge.
    const projA = path.join(root, "repo-a");
    const projB = path.join(root, "repo-b");
    for (const [dir, id] of [
      [projA, "run-a"],
      [projB, "run-b"],
    ] as const) {
      await Bun.write(path.join(dir, ".keep"), "");
      await initRepo(dir);
      await makeRunBranch(dir, root, `factory/${id}`, `${id}.txt`);
    }

    // Barrier: each project's merge callback records that it entered the lock,
    // then waits until BOTH have entered before doing the real merge. If the
    // lock were global (not keyed by projectId) the second callback could never
    // enter while the first waits — `withTimeout` would fire and fail the test.
    let entered = 0;
    let releaseBoth: () => void = () => {};
    const bothEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const window: Record<string, { start: number; end: number }> = {};

    async function timedMerge(projectId: string, projectPath: string, branch: string) {
      return mergeLock.run(projectId, async () => {
        const start = Date.now();
        entered++;
        if (entered === 2) releaseBoth();
        await withTimeout(
          bothEntered,
          2000,
          "cross-project merges never overlapped — mergeLock is serializing across projects",
        );
        const res = await mergeIntoMain({
          projectPath,
          branch,
          message: `merge ${branch}`,
          author,
        });
        window[projectId] = { start, end: Date.now() };
        return res;
      });
    }

    const [ra, rb] = await Promise.all([
      timedMerge("proj-a", projA, "factory/run-a"),
      timedMerge("proj-b", projB, "factory/run-b"),
    ]);

    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(entered).toBe(2);
    // The two execution windows overlap: each started before the other ended.
    const wa = window["proj-a"];
    const wb = window["proj-b"];
    if (!wa || !wb) throw new Error("both project merges should have recorded a window");
    expect(wa.start).toBeLessThanOrEqual(wb.end);
    expect(wb.start).toBeLessThanOrEqual(wa.end);
  });
});
