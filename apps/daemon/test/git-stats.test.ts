import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import { gitDayStats, parseNumstat } from "../src/metrics/git-stats.ts";

describe("parseNumstat", () => {
  test("counts commits and sums LOC, treating binary '-' as 0", () => {
    const out = [
      "a".repeat(40), // a commit hash line (from --format=%H)
      "10\t2\tfile1.ts",
      "5\t0\tfile2.ts",
      "b".repeat(40),
      "-\t-\tbin.png",
      "3\t1\tfile3.ts",
    ].join("\n");
    expect(parseNumstat(out)).toEqual({ commits: 2, locAdded: 18, locRemoved: 3 });
  });

  test("empty output → zeros", () => {
    expect(parseNumstat("")).toEqual({ commits: 0, locAdded: 0, locRemoved: 0 });
  });
});

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

describe("gitDayStats", () => {
  test("returns commits + LOC for commits in the window; null for a non-repo", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "git-stats-"));
    try {
      await git(["init", "-q", "-b", "main"], root);
      await git(["config", "user.name", "t"], root);
      await git(["config", "user.email", "t@t"], root);
      writeFileSync(path.join(root, "a.ts"), "one\ntwo\nthree\n");
      await git(["add", "-A"], root);
      const when = "2026-06-20T12:00:00";
      await git(["commit", "-q", "-m", "add a"], root, {
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      });

      const dayStart = Date.parse("2026-06-20T00:00:00Z");
      const stats = await gitDayStats(root, dayStart, dayStart + 86_400_000);
      expect(stats).not.toBeNull();
      expect(stats?.commits).toBe(1);
      expect(stats?.locAdded).toBe(3);
      expect(stats?.locRemoved).toBe(0);

      // a window that excludes the commit → zero commits
      const otherDay = Date.parse("2026-06-25T00:00:00Z");
      expect((await gitDayStats(root, otherDay, otherDay + 86_400_000))?.commits).toBe(0);

      // a path that isn't a git repo → null (never breaks a rollup)
      expect(
        await gitDayStats(path.join(root, "nope"), dayStart, dayStart + 86_400_000),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
