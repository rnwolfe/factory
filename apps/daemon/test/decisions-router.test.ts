import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, openSqlite, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import { listTasks, pickNextReadyTask } from "../src/projects/tasks.ts";
import { decisionsRouter } from "../src/routers/decisions.ts";
import { ScriptRegistry } from "../src/scripts/registry.ts";
import { createCallerFactory } from "../src/trpc.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

const createCaller = createCallerFactory(decisionsRouter);

function ensureSnoozeColumn(dbPath: string): void {
  // Test migrations currently lag the schema for snoozed inbox rows.
  // The decisions router already queries this column, so this harness keeps
  // the focused router test aligned with the current schema.
  const sqlite = openSqlite(dbPath);
  try {
    sqlite.exec("ALTER TABLE decisions ADD COLUMN snoozed_until integer");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("duplicate column name")) {
      throw err;
    }
  } finally {
    sqlite.close();
  }
}

function setupHarness() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-decisions-router-"));
  const dbPath = path.join(root, "data.db");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  ensureSnoozeColumn(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
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
    events,
    runs: new RunRegistry(),
    pool: new WorkerPool(1),
    config,
    scripts: new ScriptRegistry(events),
    authorized: true,
    // Keep the refinement-plan auto-iteration off the real `claude --print`
    // path so override tests stay hermetic; we only assert the resurface seam.
    planIterationScheduler: () => {},
  };
  return {
    db,
    caller: createCaller(ctx),
    events,
    published,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("decisionsRouter", () => {
  test("inbox and get include projectName for project-linked decisions", async () => {
    const h = setupHarness();
    try {
      const now = Date.now();
      const projectId = createId();
      const projectPath = path.join(h.root, "projects", "alpha");
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "alpha",
        name: "Alpha Console",
        ceremony: "personal",
        workdirPath: projectPath,
        createdAt: now,
        lastActivityAt: now,
      });

      const projectDecisionId = createId();
      const triageDecisionId = createId();
      await h.db.insert(schema.decisions).values([
        {
          id: projectDecisionId,
          kind: "blocked_run",
          projectId,
          outcome: "blocked",
          payload: { summary: "needs operator input" },
          status: "pending",
          createdAt: now + 1,
        },
        {
          id: triageDecisionId,
          kind: "triage",
          projectId: null,
          outcome: "greenlit",
          payload: { title_suggestion: "New thing" },
          status: "pending",
          createdAt: now,
        },
      ]);

      const inbox = await h.caller.inbox();
      expect(inbox.find((row) => row.id === projectDecisionId)?.projectName).toBe("Alpha Console");
      expect(inbox.find((row) => row.id === triageDecisionId)?.projectName).toBeNull();

      const fetched = await h.caller.get({ id: projectDecisionId });
      expect(fetched?.projectName).toBe("Alpha Console");
    } finally {
      h.cleanup();
    }
  });

  test("snooze view filters the default inbox and exposes snoozed items", async () => {
    const h = setupHarness();
    try {
      const now = Date.now();
      const liveId = createId();
      const expiredId = createId();
      const snoozedId = createId();
      await h.db.insert(schema.decisions).values([
        {
          id: liveId,
          kind: "triage",
          projectId: null,
          outcome: "greenlit",
          payload: { title_suggestion: "live" },
          status: "pending",
          snoozedUntil: null,
          createdAt: now,
        },
        {
          id: expiredId,
          kind: "triage",
          projectId: null,
          outcome: "greenlit",
          payload: { title_suggestion: "expired snooze" },
          status: "pending",
          snoozedUntil: now - 1_000,
          createdAt: now,
        },
        {
          id: snoozedId,
          kind: "triage",
          projectId: null,
          outcome: "greenlit",
          payload: { title_suggestion: "still snoozed" },
          status: "pending",
          snoozedUntil: now + 60_000,
          createdAt: now,
        },
      ]);

      // Default (active) view: null + expired snooze surface; future snooze hidden.
      const active = await h.caller.inbox();
      const activeIds = active.map((r) => r.id);
      expect(activeIds).toContain(liveId);
      expect(activeIds).toContain(expiredId);
      expect(activeIds).not.toContain(snoozedId);

      // Snoozed view: only the currently-snoozed item.
      const snoozed = await h.caller.inbox({ view: "snoozed" });
      const snoozedIds = snoozed.map((r) => r.id);
      expect(snoozedIds).toEqual([snoozedId]);
    } finally {
      h.cleanup();
    }
  });
});

/**
 * task-061 — ratify-vs-override detection at decision-resolve time. The
 * resurfacing trigger is solely the operator's choice of path: ratify (the
 * `action` → approve mutation) closes the decision with no follow-up; override
 * (the `overrideAgentDecision` mutation, in any of its single/multi/custom
 * shapes) emits a `decision_resurfaced` signal. No agent materiality judgement
 * is involved.
 */
describe("agent_decision resurfacing", () => {
  async function seedAgentDecision(
    db: ReturnType<typeof setupHarness>["db"],
    overrides: {
      projectId?: string | null;
      taskId?: string | null;
      runId?: string;
      responseType?: string;
    } = {},
  ): Promise<string> {
    const id = createId();
    const now = Date.now();
    await db.insert(schema.decisions).values({
      id,
      kind: "agent_decision",
      projectId: overrides.projectId ?? null,
      outcome: "decided: bun:sqlite",
      payload: {
        id: "dec-001",
        kind: "library",
        responseType: overrides.responseType ?? "single",
        summary: "use bun:sqlite over better-sqlite3",
        decided: "bun:sqlite",
        options: [
          { title: "bun:sqlite", tradeoff: "no extra dep", chosen: true },
          { title: "better-sqlite3", tradeoff: "portable" },
        ],
        runId: overrides.runId ?? "run-1",
        taskId: overrides.taskId ?? null,
      },
      status: "pending",
      createdAt: now,
    });
    return id;
  }

  function resurfaceEvents(published: DaemonEvent[], decisionId: string): DaemonEvent[] {
    return published.filter(
      (e) =>
        e.channel === "inbox" && e.kind === "decision_resurfaced" && e.decisionId === decisionId,
    );
  }

  test("ratify (action approve) closes the decision and emits no resurfacing signal", async () => {
    const h = setupHarness();
    try {
      const decisionId = await seedAgentDecision(h.db);
      const before = h.published.length;

      await h.caller.action({ decisionId, action: "approve" });

      const newEvents = h.published.slice(before);
      expect(resurfaceEvents(newEvents, decisionId)).toHaveLength(0);
      expect(newEvents.some((e) => e.channel === "inbox" && e.kind === "decision_actioned")).toBe(
        true,
      );

      const row = await h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(row?.status).toBe("actioned");
      // Ratification leaves no override marker on the payload.
      expect((row?.payload as { override?: unknown }).override).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("override to a different option emits a resurfacing signal and records the override", async () => {
    const h = setupHarness();
    try {
      const decisionId = await seedAgentDecision(h.db);
      const before = h.published.length;

      await h.caller.overrideAgentDecision({
        decisionId,
        override: { kind: "single", choice: "better-sqlite3" },
      });

      const newEvents = h.published.slice(before);
      expect(resurfaceEvents(newEvents, decisionId)).toHaveLength(1);
      expect(newEvents.some((e) => e.channel === "inbox" && e.kind === "decision_actioned")).toBe(
        true,
      );

      const row = await h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(row?.status).toBe("actioned");
      const payload = row?.payload as {
        override?: { kind: string; choice?: string };
        overrideAt?: number;
      };
      expect(payload.override).toEqual({ kind: "single", choice: "better-sqlite3" });
      expect(typeof payload.overrideAt).toBe("number");
    } finally {
      h.cleanup();
    }
  });

  test("a custom answer on an ad-hoc run (no project) resurfaces but cannot re-queue", async () => {
    const h = setupHarness();
    try {
      // No projectId: the resurfacing signal must still fire — ANY
      // non-ratification resurfaces — but there is no backend to re-queue into.
      const decisionId = await seedAgentDecision(h.db, {
        projectId: null,
        taskId: null,
        responseType: "free",
      });
      const before = h.published.length;

      const res = await h.caller.overrideAgentDecision({
        decisionId,
        override: { kind: "custom", text: "use Postgres via Bun's sql, not sqlite" },
      });

      const newEvents = h.published.slice(before);
      expect(resurfaceEvents(newEvents, decisionId)).toHaveLength(1);
      // No project → no re-queued unit of work.
      expect(res.resurfacedTaskId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("override on a file-backed project re-queues a task through the seam, linked to the decision", async () => {
    const h = setupHarness();
    try {
      const now = Date.now();
      const projectId = createId();
      const workdirPath = path.join(h.root, "projects", "beta");
      // The file backend writes into `<workdir>/.factory/work`; bootstrap makes
      // this dir for real projects, so the test stands it up explicitly.
      mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "beta",
        name: "Beta",
        ceremony: "personal",
        workdirPath,
        createdAt: now,
        lastActivityAt: now,
      });
      const decisionId = await seedAgentDecision(h.db, {
        projectId,
        taskId: "task-007",
        responseType: "multi",
      });
      const before = h.published.length;

      const res = await h.caller.overrideAgentDecision({
        decisionId,
        override: { kind: "multi", choices: ["bun:sqlite", "better-sqlite3"] },
      });

      const newEvents = h.published.slice(before);
      expect(resurfaceEvents(newEvents, decisionId)).toHaveLength(1);
      expect(res.resurfacedTaskId).not.toBeNull();
      expect(res.projectId).toBe(projectId);

      // The re-queued unit of work exists in the file backend, is ready for the
      // operator to act on, carries the audit link back to the decision, and
      // names the operator's chosen answer for the implementer.
      const tasks = await listTasks({ workdirPath });
      const requeued = tasks.find((t) => t.id === res.resurfacedTaskId);
      expect(requeued).toBeDefined();
      expect(requeued?.frontmatter.status).toBe("ready");
      expect(requeued?.frontmatter.sourceDecisionId).toBe(decisionId);
      expect(requeued?.frontmatter.parent).toBe("task-007");
      expect(requeued?.body).toContain("bun:sqlite, better-sqlite3");

      // task-064: the decision payload pins the resurfaced task id so every
      // decision surface (inbox history, decision detail) can render the
      // override as still-open work linked to its follow-up, not a closed
      // verdict.
      const row = await h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect((row?.payload as { resurfacedTaskId?: string }).resurfacedTaskId).toBe(
        res.resurfacedTaskId ?? "",
      );

      // task-064 criterion 2: the resurfaced task is queue-eligible — the same
      // `pickNextReadyTask` auto-advance uses selects it like any other ready
      // task, whether advancing from the original task or scanning fresh.
      expect(pickNextReadyTask(tasks, "task-007")?.id).toBe(res.resurfacedTaskId ?? "");
      expect(pickNextReadyTask(tasks, null)?.id).toBe(res.resurfacedTaskId ?? "");

      // No refinement plan is created anymore — the seam re-queue replaces it.
      const plans = await h.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.kind, "refinement"))
        .all();
      expect(plans).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a decision cannot be resolved twice", async () => {
    const h = setupHarness();
    try {
      const decisionId = await seedAgentDecision(h.db);
      await h.caller.overrideAgentDecision({
        decisionId,
        override: { kind: "single", choice: "better-sqlite3" },
      });
      await expect(h.caller.action({ decisionId, action: "approve" })).rejects.toThrow(
        /already actioned/,
      );
    } finally {
      h.cleanup();
    }
  });
});
