import { run } from "./exec.ts";

export interface ResolvedChannel {
  channel: "stable" | "nightly" | "dev";
  ref: string;
  sha: string;
  /** Short subject of the resolved commit, when available. */
  subject: string | null;
}

export class ChannelResolveError extends Error {
  constructor(
    public readonly code:
      | "no_tags"
      | "branch_not_found"
      | "fetch_failed"
      | "rev_failed"
      | "no_remote",
    message: string,
  ) {
    super(message);
    this.name = "ChannelResolveError";
  }
}

const SEMVER_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/;

function compareSemver(a: string, b: string): number {
  const ma = SEMVER_TAG.exec(a);
  const mb = SEMVER_TAG.exec(b);
  if (!ma || !mb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const da = Number(ma[i]);
    const db = Number(mb[i]);
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Highest-versioned tag matching `v*.*.*` from the remote. Skips
 * pre-release/build identifiers — those land on `nightly`, not `stable`.
 */
async function resolveStable(checkout: string, remote: string): Promise<ResolvedChannel> {
  // ls-remote --tags --refs --sort works without needing a local fetch.
  const ls = await run(["git", "ls-remote", "--tags", "--refs", remote], { cwd: checkout });
  if (ls.exitCode !== 0) {
    throw new ChannelResolveError("fetch_failed", `git ls-remote ${remote}: ${ls.stderr.trim()}`);
  }
  const tags: Array<{ tag: string; sha: string }> = [];
  for (const line of ls.stdout.split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]+)\s+refs\/tags\/(.+)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const sha = m[1];
    const tag = m[2];
    if (!SEMVER_TAG.test(tag)) continue;
    if (/[-+]/.test(tag)) continue; // skip pre-release / build
    tags.push({ tag, sha });
  }
  if (tags.length === 0) {
    throw new ChannelResolveError("no_tags", `no v*.*.* tags found on ${remote}`);
  }
  tags.sort((a, b) => compareSemver(a.tag, b.tag));
  const top = tags[tags.length - 1];
  if (!top) throw new ChannelResolveError("no_tags", `no v*.*.* tags found on ${remote}`);
  const subject = await readSubject(checkout, top.sha);
  return { channel: "stable", ref: top.tag, sha: top.sha, subject };
}

async function resolveBranch(
  checkout: string,
  remote: string,
  branch: string,
  channel: "nightly" | "dev",
): Promise<ResolvedChannel> {
  const fetch = await run(["git", "fetch", "--quiet", remote, branch], { cwd: checkout });
  if (fetch.exitCode !== 0) {
    if (/couldn't find remote ref/i.test(fetch.stderr)) {
      throw new ChannelResolveError("branch_not_found", `${remote}/${branch} not found`);
    }
    if (
      /repository .* does not exist|could not read from remote|not a git repository/i.test(
        fetch.stderr,
      )
    ) {
      throw new ChannelResolveError("no_remote", `git fetch failed: ${fetch.stderr.trim()}`);
    }
    throw new ChannelResolveError(
      "fetch_failed",
      `git fetch ${remote} ${branch}: ${fetch.stderr.trim()}`,
    );
  }
  const rev = await run(["git", "rev-parse", "FETCH_HEAD"], { cwd: checkout });
  if (rev.exitCode !== 0 || !rev.stdout.trim()) {
    throw new ChannelResolveError("rev_failed", "git rev-parse FETCH_HEAD failed");
  }
  const sha = rev.stdout.trim();
  const subject = await readSubject(checkout, sha);
  return { channel, ref: `${remote}/${branch}`, sha, subject };
}

async function readSubject(checkout: string, sha: string): Promise<string | null> {
  const r = await run(["git", "log", "-1", "--format=%s", sha], { cwd: checkout });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

export interface ResolveOpts {
  checkout: string;
  remote: string;
  devBranch: string;
}

export async function resolveChannel(
  channel: "stable" | "nightly" | "dev",
  opts: ResolveOpts,
): Promise<ResolvedChannel> {
  if (channel === "stable") return resolveStable(opts.checkout, opts.remote);
  if (channel === "nightly") {
    return resolveBranch(opts.checkout, opts.remote, "main", "nightly");
  }
  return resolveBranch(opts.checkout, opts.remote, opts.devBranch, "dev");
}

/** Convenience: peek at last-good.sha to compare current vs. resolved target. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
