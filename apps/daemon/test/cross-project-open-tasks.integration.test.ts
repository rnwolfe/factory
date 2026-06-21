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

interface Harness {
  db: ReturnType<typeof createDb>;
  caller: ReturnType<typeof createCaller>;
  root: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-cross-project-tasks-"));
  const dbPath = path.join(root, "data.db");
  mkdirSync(path.join(root, "projects"), { recursive: true });
  mkdirSync(path.join(root, "worktrees"), { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
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
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };
  const ctx: DaemonContext = {
    db,
    events,
    runs: new RunRegistry(),
    pool: new WorkerPool(1),
    config,
    scripts: new ScriptRegistry(events),
    authorized: true,
  };
  return {
    db,
    caller: createCaller(ctx),
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

/** Seed a project row whose workdir has an initialized `.factory/work` dir. */
function seedProject(
  db: ReturnType<typeof createDb>,
  root: string,
  slug: string,
  lastActivityAt: number,
): { id: string; workdirPath: string } {
  const id = createId();
  const workdirPath = path.join(root, "projects", slug);
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  db.insert(schema.projects)
    .values({
      id,
      slug,
      name: `Project ${slug}`,
      ideaId: null,
      role: "owner",
      ceremony: "tinker",
      tag: "active",
      workdirPath,
      createdAt: lastActivityAt,
      lastActivityAt,
      autoAdvance: true,
      model: null,
      archivedAt: null,
    })
    .run();
  return { id, workdirPath };
}

describe("projects.crossProjectOpenTasks", () => {
  test("returns each project's open tasks with project identity, omitting closed-only projects", async () => {
    const h = setupHarness();
    try {
      // alpha: one ready + one done → only the ready task is open.
      const alpha = seedProject(h.db, h.root, "alpha", 200);
      await createTask({ workdirPath: alpha.workdirPath }, { title: "Alpha open", body: "x" });
      const alphaDone = await createTask(
        { workdirPath: alpha.workdirPath },
        { title: "Alpha shipped", body: "x", status: "done" },
      );

      // beta: in_progress + blocked → both open.
      const beta = seedProject(h.db, h.root, "beta", 300);
      await createTask(
        { workdirPath: beta.workdirPath },
        { title: "Beta wip", body: "x", status: "in_progress" },
      );
      await createTask(
        { workdirPath: beta.workdirPath },
        { title: "Beta stuck", body: "x", status: "blocked" },
      );

      // gamma: only done + dropped → omitted entirely.
      const gamma = seedProject(h.db, h.root, "gamma", 100);
      await createTask(
        { workdirPath: gamma.workdirPath },
        { title: "Gamma done", body: "x", status: "done" },
      );
      await createTask(
        { workdirPath: gamma.workdirPath },
        { title: "Gamma dropped", body: "x", status: "dropped" },
      );

      const result = await h.caller.crossProjectOpenTasks();

      // gamma omitted; ordered by lastActivityAt desc → beta before alpha.
      expect(result.map((r) => r.project.slug)).toEqual(["beta", "alpha"]);

      const betaEntry = result.find((r) => r.project.slug === "beta");
      expect(betaEntry?.project).toEqual({ id: beta.id, slug: "beta", name: "Project beta" });
      expect(betaEntry?.tasks.map((t) => t.status).sort()).toEqual(["blocked", "in_progress"]);

      const alphaEntry = result.find((r) => r.project.slug === "alpha");
      expect(alphaEntry?.tasks).toHaveLength(1);
      const alphaTask = alphaEntry?.tasks[0];
      expect(alphaTask?.title).toBe("Alpha open");
      expect(alphaTask?.status).toBe("ready");
      // Task carries its own id (distinct from the done one) for link-back.
      expect(alphaTask?.id).toBeDefined();
      expect(alphaTask?.id).not.toBe(alphaDone.id);
    } finally {
      h.cleanup();
    }
  });

  test("returns [] when no project has an open task", async () => {
    const h = setupHarness();
    try {
      const solo = seedProject(h.db, h.root, "solo", 100);
      await createTask(
        { workdirPath: solo.workdirPath },
        { title: "Solo done", body: "x", status: "done" },
      );
      expect(await h.caller.crossProjectOpenTasks()).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
