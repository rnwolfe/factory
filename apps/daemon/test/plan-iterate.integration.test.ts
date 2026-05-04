import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { runPlanIteration, seedProjectSpecDraft, seedTaskPlanDraft } from "../src/plans/iterate.ts";
import { PLAN_PROMPT_KEYS } from "../src/plans/prompts.ts";
import type { TriageDecisionPayload } from "../src/triage/orchestrate.ts";

function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "factory-plan-test-"));
  const dbPath = path.join(root, "data.db");
  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function seedPlanPrompts(dbPath: string) {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const db = createDb(dbPath);
  for (const [, key] of Object.entries(PLAN_PROMPT_KEYS)) {
    if (key === "plan-feature-plan-v1") continue; // not implemented
    const file = path.join(repoRoot, "prompts", `${key}.md`);
    const content = readFileSync(file, "utf8");
    await db.insert(schema.prompts).values({
      id: createId(),
      promptKey: key,
      version: 1,
      content,
      active: true,
      createdAt: Date.now(),
    });
  }
}

describe("runPlanIteration (mock agent)", () => {
  test("project_spec: parses agent response and updates draft", async () => {
    const { dbPath, cleanup } = makeTempDb();
    try {
      runMigrations(dbPath);
      await seedPlanPrompts(dbPath);
      const db = createDb(dbPath);

      const ideaId = createId();
      await db.insert(schema.ideas).values({
        id: ideaId,
        rawText: "Daily commute prep CLI",
        goalHint: "me",
        source: "test",
        createdAt: Date.now(),
      });

      const payload: TriageDecisionPayload = {
        outcome: "greenlit",
        spec_stub: {
          summary: "tells me what to expect on my commute each morning",
          initial_tasks: [
            { title: "Scrape transit data", estimate: "small", acceptance: ["fetches API"] },
          ],
        },
      };
      const decisionId = createId();
      await db.insert(schema.decisions).values({
        id: decisionId,
        kind: "triage",
        ideaId,
        outcome: "greenlit",
        payload,
        status: "pending",
        createdAt: Date.now(),
      });

      const planId = createId();
      const seed = seedProjectSpecDraft(payload);
      await db.insert(schema.plans).values({
        id: planId,
        kind: "project_spec",
        status: "drafting",
        decisionId,
        goal: "Refine the commute CLI spec",
        draft: JSON.stringify(seed),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Operator's first comment.
      await db.insert(schema.planComments).values({
        id: createId(),
        planId,
        role: "operator",
        body: "Add a 'choose stops' task before the scrape one.",
        createdAt: Date.now(),
      });

      const mockResponse = JSON.stringify({
        summary: "Commute CLI: configurable stops + transit lookup + morning notification.",
        tasks: [
          {
            title: "Configure stops",
            estimate: "small",
            acceptance: ["operator can pick origin/destination"],
          },
          {
            title: "Scrape transit data",
            estimate: "small",
            acceptance: ["calls transit API and caches"],
          },
        ],
        unknowns: ["which transit feed (regional varies)"],
        risks: ["API rate limits"],
        reply: "Added a stops task before the scrape one.",
      });

      const result = await runPlanIteration(db, planId, {
        agentInvoker: async () => mockResponse,
      });

      expect(result.draftUpdated).toBe(true);
      expect(result.parseError).toBeNull();

      const updated = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
      expect(updated).toBeTruthy();
      const updatedDraft = JSON.parse(updated?.draft ?? "{}");
      expect(updatedDraft.tasks).toHaveLength(2);
      expect(updatedDraft.tasks[0].title).toBe("Configure stops");

      const comments = await db
        .select()
        .from(schema.planComments)
        .where(eq(schema.planComments.planId, planId))
        .all();
      expect(comments).toHaveLength(2);
      const agentComment = comments.find((c) => c.role === "agent");
      expect(agentComment?.body).toContain("Added a stops task");
      expect(agentComment?.resultingDraft).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("malformed JSON response: comment recorded, draft unchanged", async () => {
    const { dbPath, cleanup } = makeTempDb();
    try {
      runMigrations(dbPath);
      await seedPlanPrompts(dbPath);
      const db = createDb(dbPath);

      const ideaId = createId();
      await db.insert(schema.ideas).values({
        id: ideaId,
        rawText: "x",
        source: "test",
        createdAt: Date.now(),
      });

      const decisionId = createId();
      await db.insert(schema.decisions).values({
        id: decisionId,
        kind: "triage",
        ideaId,
        outcome: "greenlit",
        payload: { outcome: "greenlit" } satisfies TriageDecisionPayload,
        status: "pending",
        createdAt: Date.now(),
      });

      const seed = seedProjectSpecDraft({ outcome: "greenlit" });
      const seedJson = JSON.stringify(seed);
      const planId = createId();
      await db.insert(schema.plans).values({
        id: planId,
        kind: "project_spec",
        status: "drafting",
        decisionId,
        goal: "x",
        draft: seedJson,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const result = await runPlanIteration(db, planId, {
        agentInvoker: async () => "no json here, just prose",
      });
      expect(result.draftUpdated).toBe(false);
      expect(result.parseError).toBeTruthy();

      const after = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
      expect(after?.draft).toBe(seedJson);

      const comments = await db
        .select()
        .from(schema.planComments)
        .where(eq(schema.planComments.planId, planId))
        .all();
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("plan iteration failed");
      expect(comments[0]?.resultingDraft).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("seedTaskPlanDraft is empty but well-shaped", () => {
    const seed = seedTaskPlanDraft();
    expect(seed.kind).toBe("task_plan");
    expect(seed.steps).toEqual([]);
    expect(seed.acceptance).toEqual([]);
    expect(seed.touches).toEqual([]);
    expect(seed.risks).toEqual([]);
  });
});
