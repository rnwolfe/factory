import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../src/config.ts";
import { type DaemonEvent, EventBus } from "../src/events.ts";
import { resurfaceExpiredInboxSnoozes } from "../src/inbox-resurface.ts";
import { payloadFor } from "../src/push/dispatcher.ts";

const cfg: FactoryConfig = {
  port: 0,
  host: "127.0.0.1",
  auth: { token: "t" },
  workdir: "/tmp",
  worktreesRoot: "/tmp/wt",
  dbPath: "/tmp/db",
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
      const actionedDecisionId = createId();
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
        {
          id: actionedDecisionId,
          kind: "triage",
          projectId,
          outcome: "greenlit",
          payload: { title_suggestion: "closed decision" },
          status: "actioned",
          snoozedUntil: now - 1,
          createdAt: now,
        },
      ]);

      const planId = createId();
      const frozenPlanId = createId();
      await h.db.insert(schema.plans).values([
        {
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
        },
        {
          id: frozenPlanId,
          kind: "task_plan",
          status: "frozen",
          projectId,
          goal: "closed plan",
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
          frozenAt: now,
        },
      ]);

      const auditId = createId();
      const approvedAuditId = createId();
      await h.db.insert(schema.audits).values([
        {
          id: auditId,
          projectId,
          skillName: "design",
          skillVersion: "abc123",
          status: "completed",
          startedAt: now - 2_000,
          completedAt: now - 1_000,
          snoozedUntil: now - 1,
        },
        {
          id: approvedAuditId,
          projectId,
          skillName: "security",
          skillVersion: "abc123",
          status: "approved",
          startedAt: now - 2_000,
          completedAt: now - 1_000,
          snoozedUntil: now - 1,
          approvedAt: now,
        },
      ]);

      const feedbackId = createId();
      const resolvedFeedbackId = createId();
      await h.db.insert(schema.feedback).values([
        {
          id: feedbackId,
          vote: "down",
          body: "expired feedback",
          status: "open",
          snoozedUntil: now - 1,
          createdAt: now,
        },
        {
          id: resolvedFeedbackId,
          vote: "down",
          body: "closed feedback",
          status: "resolved",
          snoozedUntil: now - 1,
          createdAt: now,
          resolvedAt: now,
        },
      ]);

      const stats = await resurfaceExpiredInboxSnoozes({ db: h.db, events: h.events }, now);

      expect(stats).toEqual({ decisions: 1, plans: 1, audits: 1, feedback: 1 });
      const inboxEvents = h.published.filter((e) => e.channel === "inbox");
      expect(
        inboxEvents.map((e) => {
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

      const decisionEvent = inboxEvents.find(
        (e): e is Extract<DaemonEvent, { kind: "decision_created" }> =>
          e.kind === "decision_created" && e.decisionId === decisionId,
      );
      const decisionPayload = decisionEvent ? await payloadFor(decisionEvent, h.db, cfg) : null;
      expect(decisionPayload).toMatchObject({
        title: "idea ready to triage",
        url: `/decisions/${decisionId}`,
        tag: `decision:${decisionId}`,
      });

      const auditEvent = inboxEvents.find(
        (e): e is Extract<DaemonEvent, { kind: "audit_completed" }> =>
          e.kind === "audit_completed" && e.auditId === auditId,
      );
      const auditPayload = auditEvent ? await payloadFor(auditEvent, h.db, cfg) : null;
      expect(auditPayload).toMatchObject({
        title: "audit ready for review",
        url: `/projects/${projectId}/audits/${auditId}`,
        tag: `audit:${auditId}`,
      });

      const decision = await h.db
        .select({ snoozedUntil: schema.decisions.snoozedUntil })
        .from(schema.decisions)
        .where(eq(schema.decisions.id, decisionId))
        .get();
      const actionedDecision = await h.db
        .select({ snoozedUntil: schema.decisions.snoozedUntil })
        .from(schema.decisions)
        .where(eq(schema.decisions.id, actionedDecisionId))
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
      const frozenPlan = await h.db
        .select({ snoozedUntil: schema.plans.snoozedUntil })
        .from(schema.plans)
        .where(eq(schema.plans.id, frozenPlanId))
        .get();
      const audit = await h.db
        .select({ snoozedUntil: schema.audits.snoozedUntil })
        .from(schema.audits)
        .where(eq(schema.audits.id, auditId))
        .get();
      const approvedAudit = await h.db
        .select({ snoozedUntil: schema.audits.snoozedUntil })
        .from(schema.audits)
        .where(eq(schema.audits.id, approvedAuditId))
        .get();
      const feedback = await h.db
        .select({ snoozedUntil: schema.feedback.snoozedUntil })
        .from(schema.feedback)
        .where(eq(schema.feedback.id, feedbackId))
        .get();
      const resolvedFeedback = await h.db
        .select({ snoozedUntil: schema.feedback.snoozedUntil })
        .from(schema.feedback)
        .where(eq(schema.feedback.id, resolvedFeedbackId))
        .get();

      expect(decision?.snoozedUntil).toBeNull();
      expect(futureDecision?.snoozedUntil).toBe(now + 60_000);
      expect(actionedDecision?.snoozedUntil).toBe(now - 1);
      expect(plan?.snoozedUntil).toBeNull();
      expect(frozenPlan?.snoozedUntil).toBe(now - 1);
      expect(audit?.snoozedUntil).toBeNull();
      expect(approvedAudit?.snoozedUntil).toBe(now - 1);
      expect(feedback?.snoozedUntil).toBeNull();
      expect(resolvedFeedback?.snoozedUntil).toBe(now - 1);
    } finally {
      h.cleanup();
    }
  });
});
