import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import { resurfaceExpiredInboxSnoozes } from "../src/inbox-resurface.ts";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "factory-inbox-resurface-"));
  const dbPath = path.join(root, "data.db");
  mkdirSync(path.join(root, "projects"), { recursive: true });
  runMigrations(dbPath);
  const db = createDb(dbPath);
  const events = new EventBus();
  const published: DaemonEvent[] = [];
  events.subscribe((e) => published.push(e));
  return {
    db,
    events,
    published,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("inbox snooze resurfacer", () => {
  test("clears expired snoozes and reuses each item's newly-landed inbox event", async () => {
    const h = setup();
    try {
      const now = Date.now();
      const projectId = createId();
      await h.db.insert(schema.projects).values({
        id: projectId,
        slug: "resurface-test",
        name: "Resurface Test",
        ceremony: "personal",
        workdirPath: path.join(h.root, "projects", "resurface-test"),
        createdAt: now,
        lastActivityAt: now,
      });

      const decisionId = createId();
      const futureDecisionId = createId();
      await h.db.insert(schema.decisions).values([
        {
          id: decisionId,
          kind: "triage",
          projectId,
          outcome: "greenlit",
          payload: { title_suggestion: "expired decision" },
          status: "pending",
          snoozedUntil: now - 1,
          createdAt: now,
        },
        {
          id: futureDecisionId,
          kind: "triage",
          projectId,
          outcome: "greenlit",
          payload: { title_suggestion: "future decision" },
          status: "pending",
          snoozedUntil: now + 60_000,
          createdAt: now,
        },
      ]);

      const planId = createId();
      await h.db.insert(schema.plans).values({
        id: planId,
        kind: "task_plan",
        status: "drafting",
        projectId,
        goal: "expired plan",
        draft: JSON.stringify({
          kind: "task_plan",
          goal: "",
          steps: [],
          acceptance: [],
          touches: [],
          risks: [],
        }),
        snoozedUntil: now - 1,
        createdAt: now,
        updatedAt: now,
      });

      const auditId = createId();
      await h.db.insert(schema.audits).values({
        id: auditId,
        projectId,
        skillName: "design",
        skillVersion: "abc123",
        status: "completed",
        startedAt: now - 2_000,
        completedAt: now - 1_000,
        snoozedUntil: now - 1,
      });

      const feedbackId = createId();
      await h.db.insert(schema.feedback).values({
        id: feedbackId,
        vote: "down",
        body: "expired feedback",
        status: "open",
        snoozedUntil: now - 1,
        createdAt: now,
      });

      const stats = await resurfaceExpiredInboxSnoozes({ db: h.db, events: h.events }, now);

      expect(stats).toEqual({ decisions: 1, plans: 1, audits: 1, feedback: 1 });
      expect(
        h.published
          .filter((e) => e.channel === "inbox")
          .map((e) => {
            if (e.kind === "decision_created") return { kind: e.kind, id: e.decisionId };
            if (e.kind === "plan_created") return { kind: e.kind, id: e.planId };
            if (e.kind === "audit_completed") return { kind: e.kind, id: e.auditId };
            if (e.kind === "feedback_created") return { kind: e.kind, id: e.feedbackId };
            return { kind: e.kind, id: null };
          }),
      ).toEqual([
        { kind: "decision_created", id: decisionId },
        { kind: "plan_created", id: planId },
        { kind: "audit_completed", id: auditId },
        { kind: "feedback_created", id: feedbackId },
      ]);

      const decision = await h.db
        .select({ snoozedUntil: schema.decisions.snoozedUntil })
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      const futureDecision = await h.db
        .select({ snoozedUntil: schema.decisions.snoozedUntil })
        .from(schema.decisions)
        .where(eq(schema.decisions.id, futureDecisionId))
        .get();
      const plan = await h.db
        .select({ snoozedUntil: schema.plans.snoozedUntil })
        .from(schema.plans)
        .where(eq(schema.plans.id, planId))
        .get();
      const audit = await h.db
        .select({ snoozedUntil: schema.audits.snoozedUntil })
        .from(schema.audits)
        .where(eq(schema.audits.id, auditId))
        .get();
      const feedback = await h.db
        .select({ snoozedUntil: schema.feedback.snoozedUntil })
        .from(schema.feedback)
        .where(eq(schema.feedback.id, feedbackId))
        .get();

      expect(decision?.snoozedUntil).toBeNull();
      expect(futureDecision?.snoozedUntil).toBe(now + 60_000);
      expect(plan?.snoozedUntil).toBeNull();
      expect(audit?.snoozedUntil).toBeNull();
      expect(feedback?.snoozedUntil).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
