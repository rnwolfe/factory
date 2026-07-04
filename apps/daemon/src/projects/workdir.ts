import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn as bunSpawn } from "bun";

/**
 * Sync status of the workdir's current branch vs. its configured upstream.
 *
 * Ahead/behind are computed against the local remote-tracking ref
 * (`@{upstream}`, i.e. as-of-last-fetch) — the snapshot NEVER triggers a
 * network fetch. When the branch has no configured upstream (detached HEAD,
 * a fresh local branch, or no remote), `configured` is false and `state` is
 * `no_remote`; the computation never throws.
 */
export interface UpstreamStatus {
  /** True when the current branch has a configured upstream tracking ref. */
  configured: boolean;
  /** Local branch name, or null when detached / unknown. */
  branch: string | null;
  /** Upstream tracking ref (e.g. `origin/main`), or null when unconfigured. */
  remoteRef: string | null;
  /** Commits on HEAD not yet on the remote-tracking ref. */
  ahead: number;
  /** Commits on the remote-tracking ref not yet on HEAD. */
  behind: number;
  state: "up_to_date" | "ahead" | "behind" | "diverged" | "no_remote";
}

export interface WorkdirSnapshot {
  exists: boolean;
  branch: string | null;
  headSha: string | null;
  /** True when `git status --porcelain` is non-empty. */
  dirty: boolean;
  status: Array<{ code: string; path: string }>;
  commits: Array<{ sha: string; subject: string; ts: number; author: string }>;
  worktrees: Array<{ path: string; branch: string | null; head: string | null }>;
  tree: Array<{ path: string; type: "file" | "dir"; size: number | null }>;
  upstream: UpstreamStatus;
}

const NO_REMOTE: UpstreamStatus = {
  configured: false,
  branch: null,
  remoteRef: null,
  ahead: 0,
  behind: 0,
  state: "no_remote",
};

const TREE_IGNORE = new Set([
  ".git",
  "node_modules",
  ".factory",
  "worktrees", // legacy in-project location; new runs go to <workdir>/worktrees
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

async function git(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function parsePorcelain(stdout: string): Array<{ code: string; path: string }> {
  const out: Array<{ code: string; path: string }> = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    // Format: XY <space> path  (X = staged, Y = unstaged; ?? = untracked)
    const code = raw.slice(0, 2);
    const p = raw.slice(3);
    if (p.length > 0) out.push({ code, path: p });
  }
  return out;
}

function parseLog(stdout: string): WorkdirSnapshot["commits"] {
  // Format: %H\t%s\t%at\t%an
  const out: WorkdirSnapshot["commits"] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    const parts = raw.split("\t");
    if (parts.length < 4) continue;
    out.push({
      sha: parts[0] ?? "",
      subject: parts[1] ?? "",
      ts: Number.parseInt(parts[2] ?? "0", 10) * 1000,
      author: parts[3] ?? "",
    });
  }
  return out;
}

function parseWorktreeList(stdout: string): WorkdirSnapshot["worktrees"] {
  // `git worktree list --porcelain` blocks separated by blank lines.
  // Each block has lines like:
  //   worktree /path
  //   HEAD <sha>
  //   branch refs/heads/<name>   (or `detached`)
  const out: WorkdirSnapshot["worktrees"] = [];
  let cur: { path: string; branch: string | null; head: string | null } | null = null;
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null, head: null };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (cur && line.startsWith("branch refs/heads/")) {
      cur.branch = line.slice("branch refs/heads/".length);
    } else if (cur && line === "detached") {
      cur.branch = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function deriveUpstreamState(ahead: number, behind: number): UpstreamStatus["state"] {
  if (ahead > 0 && behind > 0) return "diverged";
  if (ahead > 0) return "ahead";
  if (behind > 0) return "behind";
  return "up_to_date";
}

/**
 * Compute ahead/behind against the branch's configured upstream tracking ref.
 * Reads only local refs (no fetch). Returns NO_REMOTE when the branch has no
 * upstream, when HEAD is detached, or on any git error — never throws.
 */
async function computeUpstream(workdirPath: string): Promise<UpstreamStatus> {
  // `@{upstream}` resolves to the tracking ref (e.g. origin/main) for the
  // current branch; exits non-zero when none is configured or HEAD is detached.
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    workdirPath,
  );
  if (upstream.exitCode !== 0) return NO_REMOTE;
  const remoteRef = upstream.stdout.trim();
  if (remoteRef.length === 0) return NO_REMOTE;

  const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"], workdirPath);
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() || null : null;

  // `--left-right --count <upstream>...HEAD` → "<behind>\t<ahead>"
  //   left  (upstream not in HEAD) = behind
  //   right (HEAD not in upstream) = ahead
  const counts = await git(
    ["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`],
    workdirPath,
  );
  if (counts.exitCode !== 0) return NO_REMOTE;
  const parts = counts.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
  const ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;

  return {
    configured: true,
    branch,
    remoteRef,
    ahead,
    behind,
    state: deriveUpstreamState(ahead, behind),
  };
}

async function shallowTree(root: string): Promise<WorkdirSnapshot["tree"]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: WorkdirSnapshot["tree"] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (TREE_IGNORE.has(entry)) return;
      const p = path.join(root, entry);
      try {
        const s = await stat(p);
        out.push({
          path: entry,
          type: s.isDirectory() ? "dir" : "file",
          size: s.isDirectory() ? null : s.size,
        });
      } catch {
        // skip unreadable
      }
    }),
  );
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return out;
}

export async function snapshotWorkdir(workdirPath: string): Promise<WorkdirSnapshot> {
  if (!existsSync(workdirPath)) {
    return {
      exists: false,
      branch: null,
      headSha: null,
      dirty: false,
      status: [],
      commits: [],
      worktrees: [],
      tree: [],
      upstream: NO_REMOTE,
    };
  }

  const [branch, head, porcelain, log, worktrees, tree, upstream] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], workdirPath),
    git(["rev-parse", "HEAD"], workdirPath),
    git(["status", "--porcelain=v1"], workdirPath),
    git(["log", "-n", "15", "--all", "--pretty=format:%H%x09%s%x09%at%x09%an"], workdirPath),
    git(["worktree", "list", "--porcelain"], workdirPath),
    shallowTree(workdirPath),
    computeUpstream(workdirPath),
  ]);

  const status = porcelain.exitCode === 0 ? parsePorcelain(porcelain.stdout) : [];

  return {
    exists: true,
    branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
    headSha: head.exitCode === 0 ? head.stdout.trim() || null : null,
    dirty: status.length > 0,
    status,
    commits: log.exitCode === 0 ? parseLog(log.stdout) : [],
    worktrees: worktrees.exitCode === 0 ? parseWorktreeList(worktrees.stdout) : [],
    tree,
    upstream,
  };
}
