import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pushReleaseRefs } from "../src/workers/runner.ts";

// pushReleaseRefs runs in the runner's hot path after every release run's
// merge. It must NEVER throw — a push failure leaves the local release intact
// and is reported back for a manual push. These tests exercise the two failure
// modes against a real local repo with no `origin` remote.

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

function tempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-release-push-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function initRepoWithCommit(dir: string): Promise<void> {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@t"]);
  await git(dir, ["config", "user.name", "t"]);
  await git(dir, ["commit", "--allow-empty", "-q", "-m", "init"]);
}

describe("pushReleaseRefs", () => {
  test("reports a clear note (does not throw) when the tag is missing", async () => {
    const { dir, cleanup } = tempRepo();
    try {
      await initRepoWithCommit(dir);
      const res = await pushReleaseRefs(dir, "v1.2.3");
      expect(res.ok).toBe(false);
      expect(res.note).toContain("v1.2.3");
      expect(res.note.toLowerCase()).toContain("not found");
    } finally {
      cleanup();
    }
  });

  test("reports a push failure (does not throw) when there is no origin remote", async () => {
    const { dir, cleanup } = tempRepo();
    try {
      await initRepoWithCommit(dir);
      await git(dir, ["tag", "-a", "v1.2.3", "-m", "v1.2.3"]);
      const res = await pushReleaseRefs(dir, "v1.2.3");
      expect(res.ok).toBe(false);
      expect(res.note.toLowerCase()).toContain("push failed");
    } finally {
      cleanup();
    }
  });
});
