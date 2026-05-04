import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type Db, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { runPlanIteration, seedProjectSpecDraft, seedTaskPlanDraft } from "../src/plans/iterate.ts";
import { PLAN_PROMPT_KEYS } from "../src/plans/prompts.ts";
import type { TriageDecisionPayload } from "../src/triage/orchestrate.ts";

function updatedSessionFor(db: Db, planId: string) {
  const row = db
    .select({
      claudeSessionId: schema.plans.claudeSessionId,
      promptVersion: schema.plans.promptVersion,
    })
    .from(schema.plans)
    .where(eq(schema.plans.id, planId))
    .get();
  return row ?? null;
}

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
        agentInvoker: async () => ({ text: mockResponse, sessionId: "sess-first" }),
      });

      expect(result.draftUpdated).toBe(true);
      expect(result.parseError).toBeNull();
      expect(result.sessionId).toBe("sess-first");
      expect(result.usedResume).toBe(false);

      // Session id and prompt-version stamp are persisted so the next turn
      // can resume.
      expect(updatedSessionFor(db, planId)).toEqual({
        claudeSessionId: "sess-first",
        promptVersion: "plan-project-spec-v1@1",
      });

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
        agentInvoker: async () => ({ text: "no json here, just prose", sessionId: null }),
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

  test("session resume: second turn invokes claude with --resume and a follow-up prompt", async () => {
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
      const planId = createId();
      const seed = seedProjectSpecDraft({ outcome: "greenlit" });
      await db.insert(schema.plans).values({
        id: planId,
        kind: "project_spec",
        status: "drafting",
        decisionId,
        goal: "x",
        draft: JSON.stringify(seed),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Turn 1: operator comment + fresh agent invocation. Should NOT use
      // --resume, should capture the session id.
      await db.insert(schema.planComments).values({
        id: createId(),
        planId,
        role: "operator",
        body: "First note from the operator.",
        createdAt: Date.now(),
      });
      const turn1Response = JSON.stringify({
        summary: "first turn",
        tasks: [],
        unknowns: [],
        risks: [],
        reply: "ack",
      });
      const calls: Array<{ resumeSessionId?: string; promptLength: number }> = [];
      const turn1 = await runPlanIteration(db, planId, {
        agentInvoker: async (call) => {
          calls.push({
            resumeSessionId: call.resumeSessionId,
            promptLength: call.prompt.length,
          });
          return { text: turn1Response, sessionId: "sess-A" };
        },
      });
      expect(turn1.usedResume).toBe(false);
      expect(turn1.sessionId).toBe("sess-A");
      expect(updatedSessionFor(db, planId)).toEqual({
        claudeSessionId: "sess-A",
        promptVersion: "plan-project-spec-v1@1",
      });

      // Turn 2: another operator comment. Should use --resume against
      // sess-A and pass a much shorter prompt (just the latest comment).
      await db.insert(schema.planComments).values({
        id: createId(),
        planId,
        role: "operator",
        body: "Second note — please add a 'docs' task.",
        createdAt: Date.now() + 1,
      });
      const turn2Response = JSON.stringify({
        summary: "second turn",
        tasks: [{ title: "Write docs", estimate: "small", acceptance: [] }],
        unknowns: [],
        risks: [],
        reply: "added",
      });
      const turn2 = await runPlanIteration(db, planId, {
        agentInvoker: async (call) => {
          calls.push({
            resumeSessionId: call.resumeSessionId,
            promptLength: call.prompt.length,
          });
          return { text: turn2Response, sessionId: "sess-A2" };
        },
      });
      expect(turn2.usedResume).toBe(true);
      expect(calls[1]?.resumeSessionId).toBe("sess-A");
      // Follow-up prompt is bounded by operator message + current draft;
      // the full template is ~kilobytes, the follow-up is ~hundreds of
      // bytes. A loose ratio check guards against accidentally re-rendering
      // the full template on resume.
      expect(calls[1]?.promptLength).toBeLessThan((calls[0]?.promptLength ?? 0) / 2);
      expect(turn2.draftUpdated).toBe(true);
      // The CLI may rotate session ids; the latest one is persisted.
      expect(updatedSessionFor(db, planId)).toEqual({
        claudeSessionId: "sess-A2",
        promptVersion: "plan-project-spec-v1@1",
      });
    } finally {
      cleanup();
    }
  });

  test("prompt version mismatch invalidates resume and replays full template", async () => {
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
      const planId = createId();
      const seed = seedProjectSpecDraft({ outcome: "greenlit" });
      await db.insert(schema.plans).values({
        id: planId,
        kind: "project_spec",
        status: "drafting",
        decisionId,
        goal: "x",
        draft: JSON.stringify(seed),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // Stale stamp — session was started under v0 of the prompt but the
        // active row is v1. Resume must be skipped.
        claudeSessionId: "sess-stale",
        promptVersion: "plan-project-spec-v1@0",
      });
      // Existing thread so `hasPriorAgentTurn` is true.
      await db.insert(schema.planComments).values([
        {
          id: createId(),
          planId,
          role: "operator",
          body: "old op note",
          createdAt: Date.now(),
        },
        {
          id: createId(),
          planId,
          role: "agent",
          body: "old agent reply",
          createdAt: Date.now() + 1,
        },
        {
          id: createId(),
          planId,
          role: "operator",
          body: "new op note",
          createdAt: Date.now() + 2,
        },
      ]);

      const response = JSON.stringify({
        summary: "x",
        tasks: [],
        unknowns: [],
        risks: [],
        reply: "ok",
      });
      const seen: Array<{ resumeSessionId?: string }> = [];
      const result = await runPlanIteration(db, planId, {
        agentInvoker: async (call) => {
          seen.push({ resumeSessionId: call.resumeSessionId });
          return { text: response, sessionId: "sess-fresh" };
        },
      });
      expect(result.usedResume).toBe(false);
      expect(seen[0]?.resumeSessionId).toBeUndefined();
      expect(updatedSessionFor(db, planId)).toEqual({
        claudeSessionId: "sess-fresh",
        promptVersion: "plan-project-spec-v1@1",
      });
    } finally {
      cleanup();
    }
  });

  test("resume failure falls back to fresh prompt and clears the bad session id", async () => {
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
      const planId = createId();
      const seed = seedProjectSpecDraft({ outcome: "greenlit" });
      await db.insert(schema.plans).values({
        id: planId,
        kind: "project_spec",
        status: "drafting",
        decisionId,
        goal: "x",
        draft: JSON.stringify(seed),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        claudeSessionId: "sess-evicted",
        promptVersion: "plan-project-spec-v1@1",
      });
      await db.insert(schema.planComments).values([
        {
          id: createId(),
          planId,
          role: "operator",
          body: "old op",
          createdAt: Date.now(),
        },
        {
          id: createId(),
          planId,
          role: "agent",
          body: "old agent",
          createdAt: Date.now() + 1,
        },
        {
          id: createId(),
          planId,
          role: "operator",
          body: "new op",
          createdAt: Date.now() + 2,
        },
      ]);

      const response = JSON.stringify({
        summary: "rebuilt",
        tasks: [],
        unknowns: [],
        risks: [],
        reply: "ok",
      });
      const calls: Array<{ resumeSessionId?: string }> = [];
      const result = await runPlanIteration(db, planId, {
        agentInvoker: async (call) => {
          calls.push({ resumeSessionId: call.resumeSessionId });
          if (call.resumeSessionId) {
            throw new Error("session not found (CLI evicted it)");
          }
          return { text: response, sessionId: "sess-recovered" };
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.resumeSessionId).toBe("sess-evicted");
      expect(calls[1]?.resumeSessionId).toBeUndefined();
      expect(result.draftUpdated).toBe(true);
      expect(updatedSessionFor(db, planId)).toEqual({
        claudeSessionId: "sess-recovered",
        promptVersion: "plan-project-spec-v1@1",
      });
    } finally {
      cleanup();
    }
  });
});
