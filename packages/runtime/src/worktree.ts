import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn as bunSpawn } from "bun";

export interface GitOk {
  exitCode: 0;
  stdout: string;
}

async function git(
  args: string[],
  cwd: string,
  opts: { check?: boolean; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (opts.check && exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) exited ${exitCode}: ${stderr.trim()}`);
  }
  return { exitCode, stdout, stderr };
}

export async function getHeadRef(repoPath: string): Promise<string> {
  const r = await git(["rev-parse", "HEAD"], repoPath, { check: true });
  return r.stdout.trim();
}

export async function listCommitsSince(
  repoPath: string,
  baseRef: string,
): Promise<{ sha: string; subject: string }[]> {
  const r = await git(["log", `${baseRef}..HEAD`, "--pretty=format:%H%x09%s"], repoPath);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha: sha ?? "", subject: rest.join("\t") };
    });
}

export interface EnsureWorktreeOpts {
  projectPath: string;
  branch: string;
  baseRef?: string;
  /** Custom worktree directory; defaults to `<projectPath>/worktrees/<branch>`. */
  worktreePath?: string;
  /** When the branch already exists, allow attaching to it. Default true. */
  reuse?: boolean;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  baseHead: string;
  created: boolean;
}

/**
 * Create or attach a worktree at `<projectPath>/worktrees/<branch>` for the
 * given branch name. If the branch does not yet exist it is created from
 * `baseRef` (defaulting to HEAD).
 */
export async function ensureWorktree(opts: EnsureWorktreeOpts): Promise<EnsureWorktreeResult> {
  const reuse = opts.reuse !== false;
  const worktreePath = opts.worktreePath ?? path.join(opts.projectPath, "worktrees", opts.branch);

  await mkdir(path.dirname(worktreePath), { recursive: true });

  // If something already lives at the worktree path:
  if (existsSync(worktreePath) && reuse) {
    // Confirm git considers it a worktree of the parent project.
    const list = await git(["worktree", "list", "--porcelain"], opts.projectPath);
    if (list.stdout.includes(worktreePath)) {
      const baseHead = await getHeadRef(worktreePath);
      return { worktreePath, branch: opts.branch, baseHead, created: false };
    }
    throw new Error(`worktree path collision: ${worktreePath} exists but is not a worktree`);
  }

  // Does the branch already exist?
  const branchCheck = await git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${opts.branch}`],
    opts.projectPath,
  );
  const branchExists = branchCheck.exitCode === 0;

  if (branchExists) {
    await git(["worktree", "add", worktreePath, opts.branch], opts.projectPath, {
      check: true,
    });
  } else {
    const args = ["worktree", "add", "-b", opts.branch, worktreePath];
    if (opts.baseRef) args.push(opts.baseRef);
    await git(args, opts.projectPath, { check: true });
  }

  const baseHead = await getHeadRef(worktreePath);
  return { worktreePath, branch: opts.branch, baseHead, created: true };
}

/**
 * Returns true if the worktree has no staged or unstaged changes.
 */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], worktreePath);
  return r.exitCode === 0 && r.stdout.trim() === "";
}

export interface GitAuthor {
  name: string;
  email: string;
}

/**
 * Stage all pending changes and create a single commit. Returns the commit SHA,
 * or null if there was nothing to commit. Bypasses pre-commit hooks because the
 * agent runs in an isolated worktree where hooks may not be installed.
 */
export async function commitAllChanges(
  worktreePath: string,
  message: string,
  author: GitAuthor,
): Promise<{ sha: string; subject: string } | null> {
  const status = await git(["status", "--porcelain"], worktreePath);
  if (status.exitCode !== 0 || status.stdout.trim() === "") return null;

  await git(["add", "-A"], worktreePath, { check: true });

  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  await git(["commit", "-m", message, "--no-verify"], worktreePath, { check: true, env });

  const head = await git(["rev-parse", "HEAD"], worktreePath, { check: true });
  return { sha: head.stdout.trim(), subject: message };
}

export type MergeResult =
  | { ok: true; sha: string; alreadyMerged: boolean }
  | { ok: false; reason: "dirty" | "conflict" | "wrong-branch" | "other"; message: string };

export interface MergeIntoMainOpts {
  projectPath: string;
  /** The run branch (e.g. `factory/run-<id>`) to merge in. */
  branch: string;
  /** Merge commit subject. */
  message: string;
  author: GitAuthor;
  /** The branch we're merging into. Defaults to "main". */
  targetBranch?: string;
}

/**
 * Merge a run branch into the project's main branch with a `--no-ff` merge
 * commit. This is what makes per-run branches actually compound — without
 * it, every run starts from bootstrap and the project's main never moves.
 *
 * Refuses if the project's working tree is dirty or HEAD isn't on the
 * target branch (the operator may be doing manual git work). On conflict,
 * aborts the merge so main stays clean.
 */
export async function mergeIntoMain(opts: MergeIntoMainOpts): Promise<MergeResult> {
  const { projectPath, branch, message, author } = opts;
  const targetBranch = opts.targetBranch ?? "main";

  const status = await git(["status", "--porcelain"], projectPath);
  if (status.exitCode !== 0) {
    return { ok: false, reason: "other", message: status.stderr.trim() || "git status failed" };
  }
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      reason: "dirty",
      message: "project working tree has uncommitted changes",
    };
  }

  const head = await git(["symbolic-ref", "--short", "HEAD"], projectPath);
  if (head.exitCode !== 0 || head.stdout.trim() !== targetBranch) {
    return {
      ok: false,
      reason: "wrong-branch",
      message: `project HEAD is on '${head.stdout.trim() || "(detached)"}', expected '${targetBranch}'`,
    };
  }

  // If the run branch is already an ancestor of HEAD, nothing to merge.
  const ancestor = await git(["merge-base", "--is-ancestor", branch, "HEAD"], projectPath);
  if (ancestor.exitCode === 0) {
    const sha = (await git(["rev-parse", "HEAD"], projectPath, { check: true })).stdout.trim();
    return { ok: true, sha, alreadyMerged: true };
  }

  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  // --no-ff matches the project convention (CLAUDE.md): preserve per-run
  // history as a topology marker even when fast-forward would work.
  const merge = await git(["merge", "--no-ff", "--no-verify", "-m", message, branch], projectPath, {
    env,
  });
  if (merge.exitCode !== 0) {
    // Abort so main is left clean.
    await git(["merge", "--abort"], projectPath);
    return {
      ok: false,
      reason: "conflict",
      message: (merge.stderr.trim() || merge.stdout.trim() || "merge failed").slice(0, 400),
    };
  }

  const sha = (await git(["rev-parse", "HEAD"], projectPath, { check: true })).stdout.trim();
  return { ok: true, sha, alreadyMerged: false };
}

export interface RemoveWorktreeOpts {
  projectPath: string;
  worktreePath: string;
  /** When true, force removal even if the worktree is dirty. Default false. */
  force?: boolean;
}

export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(opts.worktreePath);
  const r = await git(args, opts.projectPath);
  if (r.exitCode !== 0) {
    // Fall back to filesystem rm + prune so we don't leak directories on edge cases.
    await rm(opts.worktreePath, { recursive: true, force: true });
    await git(["worktree", "prune"], opts.projectPath);
  }
}
