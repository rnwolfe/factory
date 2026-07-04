import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../src/lib/exec.ts";
import { checkoutSha } from "../src/upgrade/checkout.ts";

let tmpRoot: string;
let repo: string;

async function git(args: string[], cwd: string): Promise<string> {
  const r = await run(["git", ...args], {
    cwd,
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function commit(cwd: string, file: string, body: string, msg: string): Promise<string> {
  writeFileSync(path.join(cwd, file), body, "utf8");
  await git(["add", file], cwd);
  await git(["commit", "-m", msg], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "factory-checkout-"));
  repo = path.join(tmpRoot, "repo");
  await git(["init", "-q", "-b", "main", repo], tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("checkoutSha", () => {
  test("fast-forwards a branch to a descendant target", async () => {
    const a = await commit(repo, "F", "1", "one");
    await git(["checkout", "-q", "-b", "work"], repo);
    const b = await commit(repo, "F", "2", "two");
    await git(["checkout", "-q", "main"], repo);
    expect(await git(["rev-parse", "HEAD"], repo)).toBe(a);

    await checkoutSha(repo, b);
    expect(await git(["rev-parse", "HEAD"], repo)).toBe(b);
    // Real FF: still on the branch.
    expect(await git(["symbolic-ref", "--short", "HEAD"], repo)).toBe("main");
  });

  test("detaches instead of silently no-op'ing when the target is an ANCESTOR", async () => {
    // `git merge --ff-only <ancestor>` exits 0 with "Already up to date"
    // WITHOUT moving HEAD — the silent-rollback-no-op class caught live on
    // dwell's first rollback (and the same trap for a checkout that sits
    // ahead of the latest stable tag).
    const older = await commit(repo, "F", "1", "one");
    await commit(repo, "F", "2", "two");

    await checkoutSha(repo, older);
    expect(await git(["rev-parse", "HEAD"], repo)).toBe(older);
  });

  test("throws (not silently succeeds) when the sha does not exist", async () => {
    await commit(repo, "F", "1", "one");
    await expect(checkoutSha(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).rejects.toThrow();
  });
});
