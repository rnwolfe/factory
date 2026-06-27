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
  const root = mkdtempSync(path.join(tmpdir(), "factory-tasks-drop-"));
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

describe("projects.tasks.drop", () => {
  test("flips an open task to dropped (file backend) so it leaves the active board", async () => {
    const h = setupHarness();
    try {
      const task = await createTask(
        { workdirPath: h.workdirPath },
        { title: "Abandon me", body: "x" },
      );
      expect(task.frontmatter.status).toBe("ready");

      const fm = await h.caller.tasks.drop({ projectId: h.projectId, taskId: task.id });
      expect(fm.status).toBe("dropped");

      // Persisted: a fresh list shows the task as dropped, not ready.
      const listed = await h.caller.tasks.list({ projectId: h.projectId });
      expect(listed.find((t) => t.id === task.id)?.status).toBe("dropped");
    } finally {
      h.cleanup();
    }
  });

  test("throws on unknown task", async () => {
    const h = setupHarness();
    try {
      await expect(
        h.caller.tasks.drop({ projectId: h.projectId, taskId: "task-999" }),
      ).rejects.toThrow("task not found");
    } finally {
      h.cleanup();
    }
  });

  test("throws on unknown project", async () => {
    const h = setupHarness();
    try {
      await expect(h.caller.tasks.drop({ projectId: "nope", taskId: "task-001" })).rejects.toThrow(
        "project not found",
      );
    } finally {
      h.cleanup();
    }
  });
});
