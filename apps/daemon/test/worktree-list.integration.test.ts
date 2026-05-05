import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import type { FactoryConfig } from "../src/config.ts";
import { listWorktrees, removeWorktreeAt } from "../src/projects/worktree-list.ts";

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  worktreesRoot: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-wt-test-"));
  const dbPath = path.join(root, "data.db");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    gitAuthor: { name: "test", email: "test@test" },
    githubToken: null,
    factoryProjectId: null,
  };
  return {
    config,
    db,
    worktreesRoot,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function makeFakeWorktree(
  worktreesRoot: string,
  slug: string,
  runId: string,
  fileBytes: number,
): Promise<string> {
  const wtPath = path.join(worktreesRoot, slug, runId);
  mkdirSync(wtPath, { recursive: true });
  writeFileSync(path.join(wtPath, "data.bin"), Buffer.alloc(fileBytes, 0x61));
  return wtPath;
}

describe("listWorktrees", () => {
  test("returns empty when worktrees root is missing", async () => {
    const h = setupHarness();
    try {
      // Point at a non-existent root
      const cfg = { ...h.config, worktreesRoot: path.join(h.config.worktreesRoot, "missing") };
      const out = await listWorktrees(cfg, h.db);
      expect(out).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("walks <slug>/<runId>, returns size and orphan flags", async () => {
    const h = setupHarness();
    try {
      await makeFakeWorktree(h.worktreesRoot, "alpha", "run-1", 100);
      await makeFakeWorktree(h.worktreesRoot, "alpha", "run-2", 250);
      await makeFakeWorktree(h.worktreesRoot, "beta", "run-3", 50);

      // Insert a project for slug=alpha and a run row for run-1 (so it's NOT orphaned).
      const projectId = createId();
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "alpha",
        name: "Alpha",
        goal: "me",
        tier: "personal",
        tag: "active",
        workdirPath: path.join(h.config.workdir, "project-alpha"),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      await h.db.insert(schema.runs).values({
        id: "run-1",
        projectId,
        status: "completed",
        agentName: "claude-code",
        branch: "factory/run-1",
        worktreePath: path.join(h.worktreesRoot, "alpha", "run-1"),
        startedAt: Date.now(),
        budgetSeconds: 60,
      });

      const out = await listWorktrees(h.config, h.db);
      expect(out).toHaveLength(3);
      // Sorted by size desc.
      expect(out[0]?.runId).toBe("run-2");
      expect(out[0]?.sizeBytes).toBeGreaterThanOrEqual(250);

      const r1 = out.find((w) => w.runId === "run-1");
      expect(r1?.orphaned).toBe(false);
      expect(r1?.runStatus).toBe("completed");
      expect(r1?.projectId).toBe(projectId);

      const r2 = out.find((w) => w.runId === "run-2");
      expect(r2?.orphaned).toBe(true);
      expect(r2?.runStatus).toBeNull();
      expect(r2?.projectId).toBe(projectId); // slug matched

      const r3 = out.find((w) => w.runId === "run-3");
      expect(r3?.orphaned).toBe(true);
      expect(r3?.projectId).toBeNull(); // beta is not a known project
    } finally {
      h.cleanup();
    }
  });
});

describe("removeWorktreeAt", () => {
  test("rejects path outside worktreesRoot", async () => {
    const h = setupHarness();
    try {
      const r = await removeWorktreeAt(h.config, h.db, "/etc/passwd");
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/under the configured worktrees root/);
    } finally {
      h.cleanup();
    }
  });

  test("rejects worktree of running run", async () => {
    const h = setupHarness();
    try {
      const wt = await makeFakeWorktree(h.worktreesRoot, "alpha", "run-active", 10);
      const projectId = createId();
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "alpha",
        name: "Alpha",
        goal: "me",
        tier: "personal",
        tag: "active",
        workdirPath: path.join(h.config.workdir, "project-alpha"),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      await h.db.insert(schema.runs).values({
        id: "run-active",
        projectId,
        status: "running",
        agentName: "claude-code",
        branch: "factory/run-active",
        worktreePath: wt,
        startedAt: Date.now(),
        budgetSeconds: 60,
      });
      const r = await removeWorktreeAt(h.config, h.db, wt);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/running/);
    } finally {
      h.cleanup();
    }
  });

  test("removes a non-active orphan worktree directory", async () => {
    const h = setupHarness();
    try {
      const wt = await makeFakeWorktree(h.worktreesRoot, "beta", "orphan-1", 10);
      const r = await removeWorktreeAt(h.config, h.db, wt);
      expect(r.ok).toBe(true);
      // Verify it's gone.
      const proc = bunSpawn({ cmd: ["test", "-d", wt], stderr: "pipe", stdout: "pipe" });
      const exit = await proc.exited;
      expect(exit).not.toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("rejects a path that is not <slug>/<runId>", async () => {
    const h = setupHarness();
    try {
      // create a deeper path
      mkdirSync(path.join(h.worktreesRoot, "alpha", "nested", "extra"), { recursive: true });
      const r = await removeWorktreeAt(
        h.config,
        h.db,
        path.join(h.worktreesRoot, "alpha", "nested", "extra"),
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/<slug>\/<runId>/);
    } finally {
      h.cleanup();
    }
  });
});
