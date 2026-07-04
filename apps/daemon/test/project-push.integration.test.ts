import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import { PushError, pushUpstream } from "../src/projects/push.ts";
import { snapshotWorkdir } from "../src/projects/workdir.ts";

// Deterministic identity so commits succeed without the machine's git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2026-07-04T12:00:00",
  GIT_COMMITTER_DATE: "2026-07-04T12:00:00",
};

async function git(args: string[], cwd: string): Promise<{ stdout: string }> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return { stdout };
}

async function commit(repo: string, file: string, body: string): Promise<void> {
  writeFileSync(path.join(repo, file), body);
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", `add ${file}`], repo);
}

/** origin.git (bare) + a `local` clone with `main` pushed and tracking set. */
async function seedOriginAndLocal(parent: string): Promise<{ origin: string; local: string }> {
  const origin = path.join(parent, "origin.git");
  const local = path.join(parent, "local");
  await git(["init", "-q", "--bare", "-b", "main", origin], parent);
  await git(["clone", "-q", origin, local], parent);
  await commit(local, "a.txt", "one\n");
  await git(["push", "-q", "-u", "origin", "main"], local);
  return { origin, local };
}

async function headSha(repo: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
}

async function expectPushError(p: Promise<unknown>, code: PushError["code"]): Promise<PushError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PushError);
    expect((err as PushError).code).toBe(code);
    return err as PushError;
  }
  throw new Error(`expected PushError(${code}) but the call resolved`);
}

describe("pushUpstream", () => {
  test("clean + strictly ahead → fast-forwards the remote", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "push-ahead-"));
    try {
      const { origin, local } = await seedOriginAndLocal(parent);
      await commit(local, "b.txt", "two\n");
      await commit(local, "c.txt", "three\n");
      const localHead = await headSha(local);

      const result = await pushUpstream(local);
      expect(result.branch).toBe("main");
      expect(result.remoteRef).toBe("origin/main");
      expect(result.pushed).toBe(2);

      // The bare origin now points at the same commit as local.
      expect((await git(["rev-parse", "main"], origin)).stdout.trim()).toBe(localHead);

      // And the workdir snapshot now reads up-to-date.
      const snap = await snapshotWorkdir(local);
      expect(snap.upstream.state).toBe("up_to_date");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("dirty worktree → PushError(dirty_worktree), no push", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "push-dirty-"));
    try {
      const { origin, local } = await seedOriginAndLocal(parent);
      await commit(local, "b.txt", "two\n"); // one commit ahead
      const originHead = (await git(["rev-parse", "main"], origin)).stdout.trim();
      // Uncommitted change makes the tree dirty.
      writeFileSync(path.join(local, "dirty.txt"), "unstaged\n");

      await expectPushError(pushUpstream(local), "dirty_worktree");
      // Remote untouched.
      expect((await git(["rev-parse", "main"], origin)).stdout.trim()).toBe(originHead);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("behind upstream → PushError(not_ahead)", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "push-behind-"));
    try {
      const { origin, local } = await seedOriginAndLocal(parent);
      const other = path.join(parent, "other");
      await git(["clone", "-q", origin, other], parent);
      await commit(other, "x.txt", "x\n");
      await git(["push", "-q", "origin", "main"], other);
      // Update local's remote-tracking ref only (no merge) — now behind by 1.
      await git(["fetch", "-q", "origin"], local);

      const err = await expectPushError(pushUpstream(local), "not_ahead");
      expect(err.upstream?.state).toBe("behind");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("diverged → PushError(not_ahead)", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "push-div-"));
    try {
      const { origin, local } = await seedOriginAndLocal(parent);
      const other = path.join(parent, "other");
      await git(["clone", "-q", origin, other], parent);
      await commit(other, "x.txt", "x\n");
      await git(["push", "-q", "origin", "main"], other);
      // Local advances too, then fetches → both sides moved.
      await commit(local, "b.txt", "two\n");
      await git(["fetch", "-q", "origin"], local);

      const err = await expectPushError(pushUpstream(local), "not_ahead");
      expect(err.upstream?.state).toBe("diverged");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("no configured upstream → PushError(no_upstream)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "push-noremote-"));
    try {
      await git(["init", "-q", "-b", "main"], root);
      await commit(root, "a.txt", "one\n");

      await expectPushError(pushUpstream(root), "no_upstream");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("remote-side non-fast-forward rejection → PushError(push_rejected), local untouched", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "push-rejected-"));
    try {
      const { origin, local } = await seedOriginAndLocal(parent);
      // Another clone advances origin WITHOUT local fetching, so local's stale
      // remote-tracking ref still reads "ahead" and the guard lets the push
      // through — but the real remote rejects it as non-fast-forward.
      const other = path.join(parent, "other");
      await git(["clone", "-q", origin, other], parent);
      await commit(other, "x.txt", "x\n");
      await git(["push", "-q", "origin", "main"], other);

      await commit(local, "b.txt", "two\n"); // local ahead vs. its STALE origin/main
      const localHead = await headSha(local);
      const originHead = (await git(["rev-parse", "main"], origin)).stdout.trim();

      await expectPushError(pushUpstream(local), "push_rejected");

      // Neither side changed: origin still at other's commit, local at its own.
      expect((await git(["rev-parse", "main"], origin)).stdout.trim()).toBe(originHead);
      expect(await headSha(local)).toBe(localHead);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
