import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import { snapshotWorkdir } from "../src/projects/workdir.ts";

// Give every git invocation a deterministic identity so commits succeed
// without touching the machine's global git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2026-07-04T12:00:00",
  GIT_COMMITTER_DATE: "2026-07-04T12:00:00",
};

async function git(args: string[], cwd: string): Promise<void> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    env: GIT_ENV,
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
}

async function commit(repo: string, file: string, body: string): Promise<void> {
  writeFileSync(path.join(repo, file), body);
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", `add ${file}`], repo);
}

describe("snapshotWorkdir upstream status", () => {
  test("no configured upstream → no_remote, never throws", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wd-upstream-none-"));
    try {
      await git(["init", "-q", "-b", "main"], root);
      await commit(root, "a.txt", "one\n");

      const snap = await snapshotWorkdir(root);
      expect(snap.upstream.configured).toBe(false);
      expect(snap.upstream.state).toBe("no_remote");
      expect(snap.upstream.remoteRef).toBeNull();
      expect(snap.upstream.ahead).toBe(0);
      expect(snap.upstream.behind).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("local ahead of origin by N → ahead:N, behind:0, state ahead", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "wd-upstream-ahead-"));
    try {
      const origin = path.join(parent, "origin.git");
      const local = path.join(parent, "local");
      await git(["init", "-q", "--bare", "-b", "main", origin], parent);
      await git(["clone", "-q", origin, local], parent);

      await commit(local, "a.txt", "one\n");
      await git(["push", "-q", "-u", "origin", "main"], local);

      // Two local commits not yet pushed.
      await commit(local, "b.txt", "two\n");
      await commit(local, "c.txt", "three\n");

      const snap = await snapshotWorkdir(local);
      expect(snap.upstream.configured).toBe(true);
      expect(snap.upstream.remoteRef).toBe("origin/main");
      expect(snap.upstream.branch).toBe("main");
      expect(snap.upstream.ahead).toBe(2);
      expect(snap.upstream.behind).toBe(0);
      expect(snap.upstream.state).toBe("ahead");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("both sides moved → state diverged with correct counts", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "wd-upstream-div-"));
    try {
      const origin = path.join(parent, "origin.git");
      const local = path.join(parent, "local");
      const other = path.join(parent, "other");
      await git(["init", "-q", "--bare", "-b", "main", origin], parent);
      await git(["clone", "-q", origin, local], parent);

      await commit(local, "a.txt", "one\n");
      await git(["push", "-q", "-u", "origin", "main"], local);

      // A second clone advances origin with two commits.
      await git(["clone", "-q", origin, other], parent);
      await commit(other, "x.txt", "x\n");
      await commit(other, "y.txt", "y\n");
      await git(["push", "-q", "origin", "main"], other);

      // Local advances by one commit, then fetches (updates the remote-tracking
      // ref only — no merge). Now HEAD and origin/main have both moved.
      await commit(local, "b.txt", "two\n");
      await git(["fetch", "-q", "origin"], local);

      const snap = await snapshotWorkdir(local);
      expect(snap.upstream.configured).toBe(true);
      expect(snap.upstream.remoteRef).toBe("origin/main");
      expect(snap.upstream.ahead).toBe(1);
      expect(snap.upstream.behind).toBe(2);
      expect(snap.upstream.state).toBe("diverged");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
