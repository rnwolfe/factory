import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { EventBus } from "../events.ts";

/**
 * Shared helper for runs and ad-hoc sessions: when `mergeIntoMain` refuses
 * (conflict, dirty tree, etc.) record a `merge_failure` decision so the
 * operator gets the same recovery affordances regardless of source.
 *
 * Returns the decision id. Callers shape `payload` themselves so each
 * source can carry its own context (runId/sessionId/branch/etc.) without
 * a shared schema.
 */
export async function recordMergeFailure(
  db: Db,
  events: EventBus,
  params: {
    projectId: string;
    reason: string;
    message: string;
    payload: Record<string, unknown>;
    /**
     * When set, the decision is recorded already-`actioned` instead of
     * `pending` — the audit-trail marker for a remediation that already ran
     * unattended (merge remediation's `dirtyAutoReset`, ADR mnx1zt27). It does
     * NOT enter the inbox: no `decision_created` (which would surface it as
     * "needs you"); a `decision_actioned` is emitted for live surfaces instead.
     */
    resolvedOutcome?: string;
  },
): Promise<string> {
  const decisionId = createId();
  const now = Date.now();
  const resolvedOutcome = params.resolvedOutcome;
  const resolved = resolvedOutcome !== undefined;
  await db.insert(schema.decisions).values({
    id: decisionId,
    kind: "merge_failure",
    projectId: params.projectId,
    outcome: resolvedOutcome ?? `merge:${params.reason}`,
    payload: params.payload,
    status: resolved ? "actioned" : "pending",
    actionedAt: resolved ? now : null,
    createdAt: now,
  });
  events.publish({
    channel: "inbox",
    kind: resolved ? "decision_actioned" : "decision_created",
    decisionId,
    projectId: params.projectId,
  });
  return decisionId;
}
