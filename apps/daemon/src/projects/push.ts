import { spawn as bunSpawn } from "bun";
import { computeUpstream, type UpstreamStatus } from "./workdir.ts";

/**
 * Guarded upstream push (feature plan lro3heax). Pushes the project's current
 * branch to its configured tracking ref with a *plain* `git push` — never
 * `--force` / `--force-with-lease`, using the daemon's ambient git credentials
 * (credential helper / ssh / cached token), so the operator can fast-forward
 * the remote from Factory without opening a terminal.
 *
 * The guard is conservative on purpose: it pushes ONLY when the worktree is
 * clean AND the branch is strictly ahead of its (as-of-last-fetch) upstream.
 * Every other state — dirty tree, behind, diverged, up-to-date, or no upstream
 * configured — refuses with a typed {@link PushError} and does not touch the
 * remote. A plain push mutates no local state, so a remote-side non-fast-forward
 * rejection (someone pushed between our snapshot and the push) leaves the
 * project exactly as it was; we surface it as {@link PushError} `push_rejected`.
 */
export class PushError extends Error {
  constructor(
    public readonly code:
      | "dirty_worktree"
      | "no_upstream"
      | "not_ahead"
      | "push_rejected"
      | "push_failed",
    message: string,
    /** The upstream snapshot at refusal time, when one was computed. */
    public readonly upstream?: UpstreamStatus,
  ) {
    super(message);
    this.name = "PushError";
  }
}

export interface PushResult {
  branch: string;
  /** The tracking ref pushed to, e.g. `origin/main`. */
  remoteRef: string;
  /** Number of commits fast-forwarded onto the remote (the pre-push ahead count). */
  pushed: number;
}

async function git(
  args: string[],
  cwd: string,
  envExtra?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = bunSpawn({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(envExtra ?? {}) },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: (err as Error).message };
  }
}

// Remote rejections git prints on a non-fast-forward push. Matched loosely so a
// genuine remote-side rejection maps to `push_rejected` rather than the generic
// `push_failed`, which the router surfaces as a distinct (CONFLICT) status.
const REJECTED_RE = /non-fast-forward|\[rejected\]|fetch first|updates were rejected/i;

/**
 * Push the current branch to its tracked upstream, or throw {@link PushError}.
 * Never fetches; the ahead/behind decision reads local refs (as of the last
 * fetch), matching the workdir snapshot the operator saw when they clicked push.
 */
export async function pushUpstream(workdirPath: string): Promise<PushResult> {
  // 1. Refuse a dirty worktree — a push shouldn't race an in-progress edit, and
  //    the workdir snapshot's `dirty` flag is what the operator is looking at.
  const status = await git(["status", "--porcelain=v1"], workdirPath);
  if (status.exitCode !== 0) {
    throw new PushError("push_failed", `git status failed: ${status.stderr.trim() || "unknown"}`);
  }
  if (status.stdout.trim().length > 0) {
    throw new PushError(
      "dirty_worktree",
      "worktree has uncommitted changes — commit or discard them before pushing",
    );
  }

  // 2. Compute upstream state (no network). Only a strictly-ahead branch with a
  //    configured upstream is pushable.
  const upstream = await computeUpstream(workdirPath);
  if (!upstream.configured || upstream.remoteRef === null || upstream.branch === null) {
    throw new PushError(
      "no_upstream",
      "current branch has no configured upstream to push to",
      upstream,
    );
  }
  if (upstream.state !== "ahead") {
    // behind, diverged, or up_to_date — none is a fast-forward we should push.
    throw new PushError(
      "not_ahead",
      `branch is ${upstream.state} relative to ${upstream.remoteRef} — only a strictly-ahead branch can be pushed`,
      upstream,
    );
  }

  // 3. Resolve the concrete remote + remote branch from the tracking ref. Using
  //    `branch.<name>.remote` is robust to remotes/branches containing slashes,
  //    where naively splitting `origin/main` would be ambiguous.
  const remoteRes = await git(["config", "--get", `branch.${upstream.branch}.remote`], workdirPath);
  const remote = remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : "";
  if (remote.length === 0) {
    throw new PushError(
      "no_upstream",
      "current branch has no configured upstream remote",
      upstream,
    );
  }
  const remoteBranch = upstream.remoteRef.startsWith(`${remote}/`)
    ? upstream.remoteRef.slice(remote.length + 1)
    : upstream.remoteRef;

  // Plain fast-forward push — no --force / --force-with-lease. GIT_TERMINAL_PROMPT=0
  // keeps a missing-credential case a fast failure instead of a hung prompt; real
  // credentials come from the daemon's ambient git config / credential helper.
  const pushRes = await git(["push", remote, `HEAD:refs/heads/${remoteBranch}`], workdirPath, {
    GIT_TERMINAL_PROMPT: "0",
  });
  if (pushRes.exitCode !== 0) {
    const detail = `${pushRes.stderr}\n${pushRes.stdout}`.trim();
    if (REJECTED_RE.test(detail)) {
      throw new PushError(
        "push_rejected",
        "remote rejected the push (non-fast-forward) — fetch and reconcile before pushing again",
        upstream,
      );
    }
    throw new PushError(
      "push_failed",
      `git push failed: ${detail.slice(0, 400) || "unknown"}`,
      upstream,
    );
  }

  return { branch: upstream.branch, remoteRef: upstream.remoteRef, pushed: upstream.ahead };
}
