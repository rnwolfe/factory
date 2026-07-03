import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import type { DaemonContext } from "../src/context.ts";
import { EventBus } from "../src/events.ts";
import type { PlanIterationScheduleRequest } from "../src/plans/schedule.ts";
import { decisionsRouter } from "../src/routers/decisions.ts";
import { ScriptRegistry } from "../src/scripts/registry.ts";
import { createCallerFactory } from "../src/trpc.ts";
import { WorkerPool } from "../src/workers/pool.ts";
import { RunRegistry } from "../src/workers/registry.ts";

const createCaller = createCallerFactory(decisionsRouter);

function setupHarness(): {
  db: ReturnType<typeof createDb>;
  caller: ReturnType<typeof createCaller>;
  scheduled: PlanIterationScheduleRequest[];
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "factory-decisions-plan-autodraft-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const scheduled: PlanIterationScheduleRequest[] = [];
  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: projectsRoot,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    runIdleTimeoutSeconds: 1200,
    agentBudgetSeconds: 0,
    eventRetentionDays: 30,
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
    caller: createCaller(ctx),
    scheduled,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("decisions router plan auto-draft", () => {
  test("approving a triage decision schedules the project_spec first draft", async () => {
    const h = setupHarness();
    try {
      const ideaId = createId();
      const decisionId = createId();
      await h.db.insert(schema.ideas).values({
        id: ideaId,
        rawText: "Make a small planning app",
        intentCeremony: "personal",
        source: "test",
        createdAt: Date.now(),
      });
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "triage",
        ideaId,
        outcome: "greenlit",
        payload: {
          outcome: "greenlit",
          weighted_score: 8,
          uncertainty: 0.1,
          axes: [],
          rationale: "Worth building.",
          title_suggestion: "Planner",
          spec_stub: {
            summary: "A small planning app.",
            initial_tasks: [
              {
                title: "Scaffold",
                estimate: "small",
                acceptance: ["Creates a runnable app"],
              },
            ],
          },
        },
        status: "pending",
        createdAt: Date.now(),
      });

      const result = await h.caller.action({ decisionId, action: "approve" });

      expect(result.planId).toBeString();
      expect(h.scheduled).toEqual([{ planId: result.planId ?? "" }]);
      const plan = await h.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, result.planId ?? ""))
        .get();
      expect(plan?.kind).toBe("project_spec");
      const decision = await h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(decision?.status).toBe("actioned");
    } finally {
      h.cleanup();
    }
  });

  test("approving an issue_intake suggested as a plan seeds a drafting feature_plan", async () => {
    const h = setupHarness();
    try {
      const projectId = createId();
      const now = Date.now();
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "integrated",
        name: "Integrated",
        ceremony: "tinker",
        taskBackend: "github-issues",
        githubRemote: "https://github.com/rnwolfe/integrated.git",
        workdirPath: path.join(tmpdir(), "integrated"),
        createdAt: now,
        lastActivityAt: now,
      });
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "issue_intake",
        projectId,
        outcome: "intake",
        payload: {
          number: 42,
          title: "Overhaul the settings surface",
          author: "alice",
          draft: {
            kind: "plan",
            title: "Overhaul the settings surface",
            summary: "Multi-step redesign.",
            reasoning: "Needs decomposition.",
          },
        },
        status: "pending",
        createdAt: now,
      });

      const result = await h.caller.action({ decisionId, action: "approve" });

      // A feature_plan was seeded (not an adopt), scheduled, and linked back to
      // the decision — so freeze can close the source issue.
      expect(result.planId).toBeString();
      expect(h.scheduled).toEqual([{ planId: result.planId ?? "" }]);
      const plan = await h.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.id, result.planId ?? ""))
        .get();
      expect(plan?.kind).toBe("feature_plan");
      expect(plan?.status).toBe("drafting");
      expect(plan?.projectId).toBe(projectId);
      expect(plan?.decisionId).toBe(decisionId);

      const decision = await h.db
        .select()
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      expect(decision?.status).toBe("actioned");
    } finally {
      h.cleanup();
    }
  });

  test("approving an issue_intake suggested as a task takes the adopt path (no plan)", async () => {
    const h = setupHarness();
    try {
      const projectId = createId();
      const now = Date.now();
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "integrated2",
        name: "Integrated2",
        ceremony: "tinker",
        taskBackend: "github-issues",
        githubRemote: "https://github.com/rnwolfe/integrated2.git",
        workdirPath: path.join(tmpdir(), "integrated2"),
        createdAt: now,
        lastActivityAt: now,
      });
      const decisionId = createId();
      await h.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "issue_intake",
        projectId,
        outcome: "intake",
        payload: {
          number: 7,
          title: "Fix the typo",
          author: "alice",
          draft: { kind: "task", title: "Fix the typo", summary: "One-liner.", reasoning: "" },
        },
        status: "pending",
        createdAt: now,
      });

      // The App is unconfigured in this harness, so `adoptIssue` returns null and
      // the task path throws — proving the approve went to adopt, not the plan
      // seam (which would have created a plan + succeeded). No plan is created.
      await expect(h.caller.action({ decisionId, action: "approve" })).rejects.toThrow(
        /could not adopt issue #7/,
      );
      const plans = await h.db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.decisionId, decisionId))
        .all();
      expect(plans.length).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
