import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import { deleteBranch, ensureWorktree, removeWorktree } from "../src/worktree.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const proc = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function initRepo(dir: string): Promise<void> {
  await git(["init", "-q", "-b", "main"], dir);
  await git(["config", "user.email", "t@t.t"], dir);
  await git(["config", "user.name", "t"], dir);
  await git(["commit", "--allow-empty", "-q", "-m", "init"], dir);
}

describe("deleteBranch", () => {
  test("removes the ephemeral branch a read-only worktree left behind", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "del-branch-"));
    try {
      const repo = path.join(root, "repo");
      await Bun.write(path.join(repo, ".keep"), "");
      await initRepo(repo);

      const branch = "factory/issue-reply-7-abcd1234";
      const worktreePath = path.join(root, "wt");
      const wt = await ensureWorktree({ projectPath: repo, branch, worktreePath });
      expect(wt.created).toBe(true);
      expect((await git(["branch", "--list", branch], repo)).trim()).toContain(branch);

      // Cleanup order: worktree first (branch can't be checked out), then ref.
      await removeWorktree({ projectPath: repo, worktreePath, force: true });
      await deleteBranch(repo, branch);

      expect((await git(["branch", "--list", branch], repo)).trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws when the branch does not exist (callers catch best-effort)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "del-branch-miss-"));
    try {
      const repo = path.join(root, "repo");
      await Bun.write(path.join(repo, ".keep"), "");
      await initRepo(repo);
      await expect(deleteBranch(repo, "factory/does-not-exist")).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
