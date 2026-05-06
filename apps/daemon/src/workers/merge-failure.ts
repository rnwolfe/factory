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
  },
): Promise<string> {
  const decisionId = createId();
  await db.insert(schema.decisions).values({
    id: decisionId,
    kind: "merge_failure",
    projectId: params.projectId,
    outcome: `merge:${params.reason}`,
    payload: params.payload,
    status: "pending",
    createdAt: Date.now(),
  });
  events.publish({
    channel: "inbox",
    kind: "decision_created",
    decisionId,
    projectId: params.projectId,
  });
  return decisionId;
}
