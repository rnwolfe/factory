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
  opts: { check?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
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
