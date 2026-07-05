import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import {
  ensureWorktree,
  getHeadRef,
  mergeIntoMain,
  removeWorktree,
  updateBranchAndRetryMerge,
} from "../src/worktree.ts";

const author = { name: "Test", email: "test@test.test" };

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Deterministic identity so commits don't depend on ambient git config.
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
  await git(["config", "user.email", author.email], dir);
  await git(["config", "user.name", author.name], dir);
  await Bun.write(path.join(dir, "base.txt"), "base\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "init"], dir);
}

/**
 * Create a run branch off the project's current HEAD holding one commit that
 * writes `fileName`=`content`, then remove the worktree so only the ref remains
 * (the shape mergeIntoMain sees after a run finishes and its worktree is torn
 * down).
 */
async function makeRunBranch(
  project: string,
  root: string,
  branch: string,
  fileName: string,
  content: string,
): Promise<void> {
  const wt = path.join(root, `wt-${branch.replace(/\//g, "-")}`);
  await ensureWorktree({ projectPath: project, branch, worktreePath: wt });
  await Bun.write(path.join(wt, fileName), content);
  await git(["add", "-A"], wt);
  await git(["commit", "-q", "-m", `add ${fileName}`], wt);
  await removeWorktree({ projectPath: project, worktreePath: wt, force: true });
}

let root: string;
let project: string;

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
  project = path.join(root, "repo");
  await Bun.write(path.join(project, ".keep"), "");
  await initRepo(project);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("mergeIntoMain", () => {
  test("clean --no-ff merge lands a merge commit on main with the branch's file", async () => {
    await makeRunBranch(project, root, "factory/run-clean", "feature.txt", "feature\n");

    const res = await mergeIntoMain({
      projectPath: project,
      branch: "factory/run-clean",
      message: "merge run-clean",
      author,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.alreadyMerged).toBe(false);
    // The branch's file is now present on main.
    expect(existsSync(path.join(project, "feature.txt"))).toBe(true);
    // HEAD is a real merge commit (2 parents), proving --no-ff.
    const parents = await git(["rev-list", "--parents", "-n", "1", "HEAD"], project);
    const parentCount = parents.stdout.trim().split(/\s+/).filter(Boolean).length - 1;
    expect(parentCount).toBe(2);
  });

  test("refuses when the project working tree is dirty; main is untouched", async () => {
    await makeRunBranch(project, root, "factory/run-dirty", "feature.txt", "feature\n");
    const before = await getHeadRef(project);
    // Dirty the project checkout.
    await Bun.write(path.join(project, "base.txt"), "locally edited\n");

    const res = await mergeIntoMain({
      projectPath: project,
      branch: "factory/run-dirty",
      message: "merge run-dirty",
      author,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("dirty");
    // main did not move.
    expect(await getHeadRef(project)).toBe(before);
  });

  test("refuses when project HEAD is not on the target branch", async () => {
    await makeRunBranch(project, root, "factory/run-wrong", "feature.txt", "feature\n");
    // Move the project off main.
    await git(["checkout", "-q", "-b", "sidebar"], project);

    const res = await mergeIntoMain({
      projectPath: project,
      branch: "factory/run-wrong",
      message: "merge run-wrong",
      author,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("wrong-branch");
  });

  test("conflicting branch → merge aborted, main left clean, conflict reported", async () => {
    // Run branch edits base.txt one way...
    await makeRunBranch(project, root, "factory/run-conflict", "base.txt", "branch version\n");
    // ...and main edits the same file another way after the branch forked.
    await Bun.write(path.join(project, "base.txt"), "main version\n");
    await git(["add", "-A"], project);
    await git(["commit", "-q", "-m", "main diverges"], project);
    const before = await getHeadRef(project);

    const res = await mergeIntoMain({
      projectPath: project,
      branch: "factory/run-conflict",
      message: "merge run-conflict",
      author,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("conflict");
    // main HEAD unmoved and the tree is clean (merge --abort undid everything).
    expect(await getHeadRef(project)).toBe(before);
    const status = await git(["status", "--porcelain"], project);
    expect(status.stdout.trim()).toBe("");
    // No in-progress merge left behind.
    expect(existsSync(path.join(project, ".git", "MERGE_HEAD"))).toBe(false);
  });

  test("already-merged branch is handled without error", async () => {
    // A branch pointing at main (no commits ahead) is already an ancestor.
    await git(["branch", "factory/run-nop", "main"], project);
    const before = await getHeadRef(project);

    const res = await mergeIntoMain({
      projectPath: project,
      branch: "factory/run-nop",
      message: "merge run-nop",
      author,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.alreadyMerged).toBe(true);
    // Nothing was committed — HEAD unchanged.
    expect(res.sha).toBe(before);
    expect(await getHeadRef(project)).toBe(before);
  });
});

/**
 * Advance `main` with a commit that writes `fileName`=`content`, simulating
 * another run's work landing on main after the run branch was cut (main@X → @Y).
 */
async function advanceMain(project: string, fileName: string, content: string): Promise<void> {
  await Bun.write(path.join(project, fileName), content);
  await git(["add", "-A"], project);
  await git(["commit", "-q", "-m", `main advances (${fileName})`], project);
}

/** Worktree paths registered on the repo other than the project checkout itself. */
async function extraWorktrees(project: string): Promise<string[]> {
  const list = await git(["worktree", "list", "--porcelain"], project);
  return list.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter((p) => path.resolve(p) !== path.resolve(project));
}

// Acceptance for feature plan dwuu3g1k: a run whose base advanced (main@X → @Y)
// must auto-merge when the changesets don't overlap, still hold on a true
// content conflict, and bound the recovery to a single rebase-and-retry.
describe("mergeIntoMain — main advanced under the run", () => {
  test("non-overlapping change auto-merges without operator intervention", async () => {
    // Run branch cut from main@X touches feature.txt...
    await makeRunBranch(project, root, "factory/run-adv-ok", "feature.txt", "feature\n");
    // ...then main advances to @Y with a change to a DIFFERENT file (no overlap).
    await advanceMain(project, "mainfile.txt", "main work\n");

    const res = await mergeIntoMain({
      projectPath: project,
      branch: "factory/run-adv-ok",
      message: "merge run-adv-ok",
      author,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Both changesets are present on main — the merge compounded on the advance.
    expect(existsSync(path.join(project, "feature.txt"))).toBe(true);
    expect(existsSync(path.join(project, "mainfile.txt"))).toBe(true);
    // No scratch worktree leaked regardless of which path landed it.
    expect(await extraWorktrees(project)).toEqual([]);
  });

  test("true content conflict is still held: aborted, main clean, nothing leaks", async () => {
    const runBranch = "factory/run-adv-conflict";
    // Run branch and main both edit base.txt at the same spot after the fork.
    await makeRunBranch(project, root, runBranch, "base.txt", "branch version\n");
    await advanceMain(project, "base.txt", "main version\n");
    const mainBefore = await getHeadRef(project);
    const runTipBefore = (await git(["rev-parse", runBranch], project)).stdout.trim();

    const res = await mergeIntoMain({
      projectPath: project,
      branch: runBranch,
      message: "merge run-adv-conflict",
      author,
    });

    // The single rebase-and-retry can't resolve a real overlap → held.
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected conflict");
    expect(res.reason).toBe("conflict");
    // main HEAD unmoved and the tree is clean (both the first-attempt abort and
    // the failed retry cleaned up after themselves).
    expect(await getHeadRef(project)).toBe(mainBefore);
    expect((await git(["status", "--porcelain"], project)).stdout.trim()).toBe("");
    expect(existsSync(path.join(project, ".git", "MERGE_HEAD"))).toBe(false);
    // The run branch ref was never rewritten by the detached rebase.
    expect((await git(["rev-parse", runBranch], project)).stdout.trim()).toBe(runTipBefore);
    // The scratch worktree was torn down — no leaked registrations or dirs.
    expect(await extraWorktrees(project)).toEqual([]);
  });
});

// Direct coverage of the bounded recovery mechanism itself (acceptance §1 recovery
// path + §3 boundedness), independent of whether git's first 3-way merge already
// resolved the case.
describe("updateBranchAndRetryMerge", () => {
  test("rebases onto latest main and lands the merge (recovered=true)", async () => {
    const runBranch = "factory/run-retry-ok";
    await makeRunBranch(project, root, runBranch, "feature.txt", "feature\n");
    await advanceMain(project, "mainfile.txt", "main work\n");
    const runTipBefore = (await git(["rev-parse", runBranch], project)).stdout.trim();
    const scratch = path.join(root, "scratch-ok");

    const res = await updateBranchAndRetryMerge({
      projectPath: project,
      branch: runBranch,
      targetBranch: "main",
      message: "retry merge run-retry-ok",
      author,
      scratchPath: scratch,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.recovered).toBe(true);
    // Both changesets landed; HEAD is a real merge commit (--no-ff preserved).
    expect(existsSync(path.join(project, "feature.txt"))).toBe(true);
    expect(existsSync(path.join(project, "mainfile.txt"))).toBe(true);
    const parents = await git(["rev-list", "--parents", "-n", "1", "HEAD"], project);
    expect(parents.stdout.trim().split(/\s+/).filter(Boolean).length - 1).toBe(2);
    // The detached rebase left the run branch ref untouched.
    expect((await git(["rev-parse", runBranch], project)).stdout.trim()).toBe(runTipBefore);
    // Scratch worktree fully cleaned up.
    expect(existsSync(scratch)).toBe(false);
    expect(await extraWorktrees(project)).toEqual([]);
  });

  test("a real overlap re-conflicts on the rebase: single attempt, main untouched", async () => {
    const runBranch = "factory/run-retry-conflict";
    await makeRunBranch(project, root, runBranch, "base.txt", "branch version\n");
    await advanceMain(project, "base.txt", "main version\n");
    const mainBefore = await getHeadRef(project);
    const runTipBefore = (await git(["rev-parse", runBranch], project)).stdout.trim();
    const scratch = path.join(root, "scratch-conflict");

    const res = await updateBranchAndRetryMerge({
      projectPath: project,
      branch: runBranch,
      targetBranch: "main",
      message: "retry merge run-retry-conflict",
      author,
      scratchPath: scratch,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected conflict");
    expect(res.reason).toBe("conflict");
    // Bounded, single pass: main never moved, tree clean, run branch ref intact,
    // and the scratch worktree/rebase state is fully gone (no loop, no leak).
    expect(await getHeadRef(project)).toBe(mainBefore);
    expect((await git(["status", "--porcelain"], project)).stdout.trim()).toBe("");
    expect(existsSync(path.join(project, ".git", "MERGE_HEAD"))).toBe(false);
    expect((await git(["rev-parse", runBranch], project)).stdout.trim()).toBe(runTipBefore);
    expect(existsSync(scratch)).toBe(false);
    expect(await extraWorktrees(project)).toEqual([]);
  });
});

describe("ensureWorktree", () => {
  test("creates the worktree on the expected branch at the expected path", async () => {
    const wt = path.join(root, "wt-ensure");
    const projectHead = await getHeadRef(project);

    const r = await ensureWorktree({
      projectPath: project,
      branch: "factory/run-ensure",
      worktreePath: wt,
    });

    expect(r.created).toBe(true);
    expect(r.worktreePath).toBe(wt);
    expect(r.branch).toBe("factory/run-ensure");
    expect(r.baseHead).toBe(projectHead);
    expect(existsSync(wt)).toBe(true);
    const symref = await git(["symbolic-ref", "--short", "HEAD"], wt);
    expect(symref.stdout.trim()).toBe("factory/run-ensure");
  });

  test("is idempotent: a second call to the same path reuses it (created=false)", async () => {
    const wt = path.join(root, "wt-idem");
    const first = await ensureWorktree({
      projectPath: project,
      branch: "factory/run-idem",
      worktreePath: wt,
    });
    expect(first.created).toBe(true);

    const second = await ensureWorktree({
      projectPath: project,
      branch: "factory/run-idem",
      worktreePath: wt,
    });
    expect(second.created).toBe(false);
    expect(second.worktreePath).toBe(wt);
    expect(second.branch).toBe("factory/run-idem");
  });
});

describe("removeWorktree", () => {
  test("falls back to rm + prune when the worktree dir was deleted manually", async () => {
    const wt = path.join(root, "wt-gone");
    await ensureWorktree({
      projectPath: project,
      branch: "factory/run-gone",
      worktreePath: wt,
    });
    // Simulate the dir vanishing out from under git.
    rmSync(wt, { recursive: true, force: true });
    expect(existsSync(wt)).toBe(false);

    // `git worktree remove` will fail (dir gone); the rm+prune fallback must
    // still leave things consistent without throwing.
    await removeWorktree({ projectPath: project, worktreePath: wt });

    const list = await git(["worktree", "list", "--porcelain"], project);
    expect(list.stdout.includes(wt)).toBe(false);
  });

  test("removes a live worktree and deregisters it", async () => {
    const wt = path.join(root, "wt-live");
    await ensureWorktree({
      projectPath: project,
      branch: "factory/run-live",
      worktreePath: wt,
    });
    expect(existsSync(wt)).toBe(true);

    await removeWorktree({ projectPath: project, worktreePath: wt, force: true });

    expect(existsSync(wt)).toBe(false);
    const list = await git(["worktree", "list", "--porcelain"], project);
    expect(list.stdout.includes(wt)).toBe(false);
  });
});
