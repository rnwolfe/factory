import { type Db, schema } from "@factory/db";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { EventBus } from "./events.ts";

const TICK_MS = 60_000;

export interface InboxResurfaceDeps {
  db: Db;
  events: EventBus;
}

export interface InboxResurfaceStats {
  decisions: number;
  plans: number;
  audits: number;
  feedback: number;
}

/**
 * Clear expired inbox snoozes and re-emit the same inbox event each primitive
 * uses when it first lands. The row status remains unchanged; clearing
 * `snoozedUntil` makes the item stable in the active inbox instead of relying
 * on every query remembering that "past timestamp" means visible.
 */
export async function resurfaceExpiredInboxSnoozes(
  deps: InboxResurfaceDeps,
  now = Date.now(),
): Promise<InboxResurfaceStats> {
  const { db, events } = deps;
  const stats: InboxResurfaceStats = { decisions: 0, plans: 0, audits: 0, feedback: 0 };

  const decisions = await db
    .select({
      id: schema.decisions.id,
      projectId: schema.decisions.projectId,
    })
    .from(schema.decisions)
    .where(
      and(
        eq(schema.decisions.status, "pending"),
        isNotNull(schema.decisions.snoozedUntil),
        lte(schema.decisions.snoozedUntil, now),
      ),
    )
    .all();
  for (const row of decisions) {
    await db
      .update(schema.decisions)
      .set({ snoozedUntil: null })
      .where(eq(schema.decisions.id, row.id));
    stats.decisions++;
    events.publish({
      channel: "inbox",
      kind: "decision_created",
      decisionId: row.id,
      projectId: row.projectId,
    });
  }

  const plans = await db
    .select({
      id: schema.plans.id,
      kind: schema.plans.kind,
      projectId: schema.plans.projectId,
    })
    .from(schema.plans)
    .where(
      and(
        eq(schema.plans.status, "drafting"),
        isNotNull(schema.plans.snoozedUntil),
        lte(schema.plans.snoozedUntil, now),
      ),
    )
    .all();
  for (const row of plans) {
    await db.update(schema.plans).set({ snoozedUntil: null }).where(eq(schema.plans.id, row.id));
    stats.plans++;
    events.publish({
      channel: "inbox",
      kind: "plan_created",
      planId: row.id,
      planKind: row.kind,
      projectId: row.projectId,
    });
  }

  const audits = await db
    .select({
      id: schema.audits.id,
      projectId: schema.audits.projectId,
    })
    .from(schema.audits)
    .where(
      and(
        eq(schema.audits.status, "completed"),
        isNotNull(schema.audits.snoozedUntil),
        lte(schema.audits.snoozedUntil, now),
      ),
    )
    .all();
  for (const row of audits) {
    await db.update(schema.audits).set({ snoozedUntil: null }).where(eq(schema.audits.id, row.id));
    stats.audits++;
    events.publish({
      channel: "inbox",
      kind: "audit_completed",
      auditId: row.id,
      projectId: row.projectId,
    });
  }

  const feedback = await db
    .select({ id: schema.feedback.id })
    .from(schema.feedback)
    .where(
      and(
        inArray(schema.feedback.status, ["open", "in_progress"]),
        isNotNull(schema.feedback.snoozedUntil),
        lte(schema.feedback.snoozedUntil, now),
      ),
    )
    .all();
  for (const row of feedback) {
    await db
      .update(schema.feedback)
      .set({ snoozedUntil: null })
      .where(eq(schema.feedback.id, row.id));
    stats.feedback++;
    events.publish({
      channel: "inbox",
      kind: "feedback_created",
      feedbackId: row.id,
    });
  }

  return stats;
}

export function startInboxSnoozeResurfacer(deps: InboxResurfaceDeps): () => void {
  async function tick(): Promise<void> {
    try {
      const stats = await resurfaceExpiredInboxSnoozes(deps);
      const total = stats.decisions + stats.plans + stats.audits + stats.feedback;
      if (total > 0) {
        console.log(
          `[inbox] resurfaced expired snoozes — decisions: ${stats.decisions}, plans: ${stats.plans}, audits: ${stats.audits}, feedback: ${stats.feedback}`,
        );
      }
    } catch (err) {
      console.warn(
        `[inbox] expired snooze resurface failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  void tick();
  const handle = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(handle);
}
