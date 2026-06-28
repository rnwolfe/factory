import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type PlanStatus, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import type { PlanIterationScheduleRequest } from "../src/plans/schedule.ts";
import { createTask } from "../src/projects/tasks.ts";
import { plansRouter } from "../src/routers/plans.ts";
import { ScriptRegistry } from "../src/scripts/registry.ts";
import { createCallerFactory } from "../src/trpc.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

const createCaller = createCallerFactory(plansRouter);

interface Harness {
  db: ReturnType<typeof createDb>;
  published: DaemonEvent[];
  scheduled: PlanIterationScheduleRequest[];
  caller: ReturnType<typeof createCaller>;
  projectsRoot: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "factory-plans-router-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  const scheduled: PlanIterationScheduleRequest[] = [];
  events.subscribe((e) => published.push(e));
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: projectsRoot,
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
    planIterationScheduler: (request) => scheduled.push(request),
  };
  return {
    db,
    published,
    scheduled,
    caller: createCaller(ctx),
    projectsRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seedPlan(h: Harness, status: PlanStatus): Promise<string> {
  const id = createId();
  const now = Date.now();
  await h.db.insert(schema.plans).values({
    id,
    kind: "task_plan",
    status,
    goal: `${status} plan`,
    draft: JSON.stringify({
      kind: "task_plan",
      goal: "",
      steps: [],
      acceptance: [],
      touches: [],
      risks: [],
    }),
    createdAt: now,
    updatedAt: now,
    frozenAt: status === "frozen" || status === "superseded" ? now - 1 : null,
    abandonedAt: status === "abandoned" ? now - 1 : null,
  });
  return id;
}

describe("plans router", () => {
  test("startProjectFoundry creates a project_spec plan and schedules its first draft", async () => {
    const h = setupHarness();
    try {
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "triage",
        outcome: "greenlit",
        payload: {
          outcome: "greenlit",
          title_suggestion: "Inbox Plan",
          spec_stub: {
            summary: "Turn an approved triage card into a plan.",
            initial_tasks: [],
          },
        },
        status: "pending",
        createdAt: Date.now(),
      });

      const result = await h.caller.startProjectFoundry({ decisionId });

      const row = await h.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, result.planId))
        .get();
      expect(row?.kind).toBe("project_spec");
      expect(h.scheduled).toEqual([{ planId: result.planId }]);
    } finally {
      h.cleanup();
    }
  });

  test("startRefinement creates a refinement plan and schedules its first draft", async () => {
    const h = setupHarness();
    try {
      const projectId = createId();
      const workdirPath = path.join(h.projectsRoot, "demo");
      mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "demo",
        name: "Demo",
        ceremony: "personal",
        workdirPath,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      const task = await createTask(
        { workdirPath },
        { title: "Tighten acceptance", body: "Make the task sharper." },
      );

      const result = await h.caller.startRefinement({ projectId, taskId: task.id });

      const row = await h.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, result.planId))
        .get();
      expect(row?.kind).toBe("refinement");
      expect(h.scheduled).toEqual([{ planId: result.planId, projectId }]);
    } finally {
      h.cleanup();
    }
  });

  test.each([
    "drafting",
    "frozen",
    "superseded",
  ] as const)("abandon archives a %s plan", async (status) => {
    const h = setupHarness();
    try {
      const planId = await seedPlan(h, status);

      await h.caller.abandon({ planId });

      const row = await h.db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
      expect(row?.status).toBe("abandoned");
      expect(row?.abandonedAt).toBeNumber();
      expect(h.published).toContainEqual({
        channel: "inbox",
        kind: "plan_abandoned",
        planId,
        projectId: null,
      });
    } finally {
      h.cleanup();
    }
  });

  test("abandon rejects an already-abandoned plan", async () => {
    const h = setupHarness();
    try {
      const planId = await seedPlan(h, "abandoned");

      await expect(h.caller.abandon({ planId })).rejects.toThrow("plan already abandoned");
    } finally {
      h.cleanup();
    }
  });

  // WS C slice 3 (ADR-014): autonomy-eligible task plans need testable acceptance.
  async function seedProjectPlan(
    h: Harness,
    autonomyMode: "collaborative" | "autonomous",
    acceptance: string[],
  ): Promise<string> {
    const now = Date.now();
    const projectId = createId();
    await h.db.insert(schema.projects).values({
      id: projectId,
      slug: `p-${projectId.slice(0, 6)}`,
      name: "P",
      ceremony: "personal",
      autonomyMode,
      workdirPath: path.join(tmpdir(), projectId),
      createdAt: now,
      lastActivityAt: now,
    });
    const planId = createId();
    await h.db.insert(schema.plans).values({
      id: planId,
      kind: "task_plan",
      status: "drafting",
      projectId,
      goal: "g",
      draft: JSON.stringify({
        kind: "task_plan",
        goal: "",
        steps: [],
        acceptance,
        touches: [],
        risks: [],
      }),
      createdAt: now,
      updatedAt: now,
    });
    return planId;
  }

  test("autonomous task_plan freeze is blocked without acceptance criteria", async () => {
    const h = setupHarness();
    try {
      const planId = await seedProjectPlan(h, "autonomous", []);
      await expect(h.caller.freeze({ planId })).rejects.toThrow(/acceptance criterion/);
      const plan = h.db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
      expect(plan?.status).toBe("drafting"); // not frozen
    } finally {
      h.cleanup();
    }
  });

  test("autonomous task_plan freeze succeeds with acceptance criteria", async () => {
    const h = setupHarness();
    try {
      const planId = await seedProjectPlan(h, "autonomous", ["compiles", "tests pass"]);
      await h.caller.freeze({ planId });
      const plan = h.db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
      expect(plan?.status).toBe("frozen");
    } finally {
      h.cleanup();
    }
  });

  test("collaborative task_plan freeze is unaffected by the acceptance gate", async () => {
    const h = setupHarness();
    try {
      const planId = await seedProjectPlan(h, "collaborative", []);
      await h.caller.freeze({ planId });
      const plan = h.db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
      expect(plan?.status).toBe("frozen");
    } finally {
      h.cleanup();
    }
  });
});
