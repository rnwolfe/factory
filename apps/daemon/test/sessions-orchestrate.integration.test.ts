import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import {
  endSession,
  isSessionActive,
  recoverOrphanedSessions,
  SessionError,
  startSession,
} from "../src/sessions/orchestrate.ts";

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  events: EventBus;
  root: string;
  cleanup: () => void;
}

async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = bunSpawn({ cmd: ["tmux", "-V"], stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const p = bunSpawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const code = await p.exited;
  return { exitCode: code, stdout };
}

async function setupHarness(): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-sessions-test-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    agentBudgetSeconds: 0,
    gitAuthor: { name: "test", email: "t@t" },
    githubToken: null,
    factoryProjectId: null,
  };
  return {
    config,
    db,
    events,
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function seedProject(h: Harness, slug = "demo"): Promise<string> {
  const id = createId();
  const workdirPath = path.join(h.root, "projects", slug);
  mkdirSync(workdirPath, { recursive: true });
  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@example.com"], workdirPath);
  await writeFile(path.join(workdirPath, "README.md"), "# init\n", "utf8");
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "init"], workdirPath);
  const now = Date.now();
  h.db
    .insert(schema.projects)
    .values({
      id,
      slug,
      name: slug,
      ideaId: null,
      goal: "me",
      tier: "tinker",
      tag: "active",
      workdirPath,
      createdAt: now,
      lastActivityAt: now,
      autoAdvance: true,
      model: null,
      archivedAt: null,
    })
    .run();
  return id;
}

describe("sessions orchestrate", () => {
  test("startSession creates a worktree, a row, and registers an active handle", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const projectId = await seedProject(h);
      const res = await startSession(h.config, h.db, h.events, {
        projectId,
        mode: "shell",
      });
      expect(res.id).toBeTruthy();
      expect(res.branchName.startsWith("factory/adhoc-")).toBe(true);
      const row = h.db.select().from(schema.sessions).where(eq(schema.sessions.id, res.id)).get();
      expect(row?.status).toBe("running");
      expect(row?.mode).toBe("shell");
      expect(isSessionActive(res.id)).toBe(true);
      // Tear down so the test cleans up.
      await endSession(h.config, h.db, h.events, res.id, { abort: true });
    } finally {
      h.cleanup();
    }
  });

  test("end with no commits cleans up worktree and marks ended", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const projectId = await seedProject(h);
      const res = await startSession(h.config, h.db, h.events, {
        projectId,
        mode: "shell",
      });
      const final = await endSession(h.config, h.db, h.events, res.id);
      expect(final.status).toBe("ended");
      expect(final.commitCount).toBe(0);
      const row = h.db.select().from(schema.sessions).where(eq(schema.sessions.id, res.id)).get();
      expect(row?.status).toBe("ended");
      expect(row?.endedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("end with commits merges into main and marks merged", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const projectId = await seedProject(h);
      const res = await startSession(h.config, h.db, h.events, {
        projectId,
        mode: "shell",
      });
      // Drop a commit on the session worktree.
      await writeFile(path.join(res.worktreePath, "added.md"), "session work\n", "utf8");
      await git(["add", "-A"], res.worktreePath);
      await git(["commit", "-q", "-m", "session: add file"], res.worktreePath);
      const final = await endSession(h.config, h.db, h.events, res.id);
      expect(final.status).toBe("merged");
      expect(final.commitCount).toBe(1);
      // Main now has the commit.
      const project = h.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .get();
      const log = await git(["log", "--oneline", "main"], project?.workdirPath ?? "");
      expect(log.stdout).toContain("session: add file");
    } finally {
      h.cleanup();
    }
  });

  test("abort kills tmux, marks aborted, leaves branch on disk", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const projectId = await seedProject(h);
      const res = await startSession(h.config, h.db, h.events, {
        projectId,
        mode: "shell",
      });
      const final = await endSession(h.config, h.db, h.events, res.id, { abort: true });
      expect(final.status).toBe("aborted");
      const row = h.db.select().from(schema.sessions).where(eq(schema.sessions.id, res.id)).get();
      expect(row?.status).toBe("aborted");
      expect(isSessionActive(res.id)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("starting a second session for the same project is refused", async () => {
    if (!(await tmuxAvailable())) return;
    const h = await setupHarness();
    try {
      const projectId = await seedProject(h);
      const a = await startSession(h.config, h.db, h.events, {
        projectId,
        mode: "shell",
      });
      let thrown: unknown;
      try {
        await startSession(h.config, h.db, h.events, { projectId, mode: "shell" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionError);
      if (thrown instanceof SessionError) {
        expect(thrown.code).toBe("concurrent_session");
      }
      await endSession(h.config, h.db, h.events, a.id, { abort: true });
    } finally {
      h.cleanup();
    }
  });

  test("recoverOrphanedSessions marks running rows as aborted", async () => {
    const h = await setupHarness();
    try {
      const projectId = await seedProject(h);
      // Insert a 'running' row directly (simulating a crashed daemon).
      const id = createId();
      const now = Date.now();
      h.db
        .insert(schema.sessions)
        .values({
          id,
          projectId,
          status: "running",
          mode: "claude",
          description: null,
          branchName: "factory/adhoc-stale",
          worktreePath: "/nonexistent/path",
          startedAt: now,
          endedAt: null,
          commitCount: 0,
          mergedAt: null,
          mergeError: null,
        })
        .run();
      const reaped = await recoverOrphanedSessions(h.db, h.events);
      expect(reaped).toBe(1);
      const row = h.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
      expect(row?.status).toBe("aborted");
      expect(row?.endedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
