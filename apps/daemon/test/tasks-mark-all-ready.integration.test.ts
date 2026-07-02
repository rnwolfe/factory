import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";

import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { EventBus } from "../src/events.ts";
import { createTask } from "../src/projects/tasks.ts";
import { projectsRouter } from "../src/routers/projects.ts";
import { ScriptRegistry } from "../src/scripts/registry.ts";
import { createCallerFactory } from "../src/trpc.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

const createCaller = createCallerFactory(projectsRouter);

function setupHarness() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-tasks-mark-ready-"));
  const dbPath = path.join(root, "data.db");
  mkdirSync(path.join(root, "projects"), { recursive: true });
  mkdirSync(path.join(root, "worktrees"), { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: root,
    worktreesRoot: path.join(root, "worktrees"),
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    agentBudgetSeconds: 0,
    gitAuthor: { name: "Test", email: "test@test" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    githubReplyAllowlist: [],
    publicBaseUrl: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  const ctx: DaemonContext = {
    db,
    events: new EventBus(),
    runs: new RunRegistry(),
    pool: new WorkerPool(1),
    config,
    scripts: new ScriptRegistry(new EventBus()),
    authorized: true,
  };
  const id = createId();
  const workdirPath = path.join(root, "projects", "alpha");
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  db.insert(schema.projects)
    .values({
      id,
      slug: "alpha",
      name: "Project alpha",
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath,
      createdAt: 1,
      lastActivityAt: 1,
      autoAdvance: true,
      model: null,
      archivedAt: null,
    })
    .run();
  return {
    db,
    caller: createCaller(ctx),
    projectId: id,
    workdirPath,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function makeTriageTask(h: ReturnType<typeof setupHarness>, title: string) {
  const task = await createTask({ workdirPath: h.workdirPath }, { title, body: "x" });
  await h.caller.tasks.updateStatus({
    projectId: h.projectId,
    taskId: task.id,
    status: "needs_triage",
  });
  return task.id;
}

describe("projects.tasks.markAllReady", () => {
  test("promotes every needs_triage task to ready and leaves other lanes untouched", async () => {
    const h = setupHarness();
    try {
      const a = await makeTriageTask(h, "Adopted A");
      const b = await makeTriageTask(h, "Adopted B");
      // A task already ready — must not be touched or double-counted.
      const ready = await createTask(
        { workdirPath: h.workdirPath },
        { title: "Already ready", body: "x" },
      );
      // A backlog task — deliberately not promoted (only triage lane moves).
      const backlogTask = await createTask(
        { workdirPath: h.workdirPath },
        { title: "Backlog", body: "x" },
      );
      await h.caller.tasks.updateStatus({
        projectId: h.projectId,
        taskId: backlogTask.id,
        status: "backlog",
      });

      const res = await h.caller.tasks.markAllReady({ projectId: h.projectId });
      expect(res.promoted).toBe(2);

      const listed = await h.caller.tasks.list({ projectId: h.projectId });
      const byId = new Map(listed.map((t) => [t.id, t.status]));
      expect(byId.get(a)).toBe("ready");
      expect(byId.get(b)).toBe("ready");
      expect(byId.get(ready.id)).toBe("ready");
      expect(byId.get(backlogTask.id)).toBe("backlog");
    } finally {
      h.cleanup();
    }
  });

  test("no-op when nothing is in triage", async () => {
    const h = setupHarness();
    try {
      await createTask({ workdirPath: h.workdirPath }, { title: "Already ready", body: "x" });
      const res = await h.caller.tasks.markAllReady({ projectId: h.projectId });
      expect(res.promoted).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("throws on unknown project", async () => {
    const h = setupHarness();
    try {
      await expect(h.caller.tasks.markAllReady({ projectId: "nope" })).rejects.toThrow(
        "project not found",
      );
    } finally {
      h.cleanup();
    }
  });
});
