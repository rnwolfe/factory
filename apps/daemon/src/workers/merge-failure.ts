import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { resolveAutonomyConfig } from "../autonomy/config.ts";
import type { EventBus } from "../events.ts";

/**
 * Canonical `decisions.outcome` strings for a `merge_failure` decision, keyed by
 * the resolution path that produced them. These are the SINGLE source of truth
 * for how a merge failure was ultimately resolved — every resolution site writes
 * exactly one of these, and {@link classifyMergeResolution} maps them back to the
 * five ops-metric buckets (feature plan mnx1zt27). Change a string here and both
 * the writer and the metric move together.
 */
export const MERGE_FAILURE_OUTCOME = {
  /** Lever `dirtyAutoReset` on → daemon reset a dirty `main` + retried, unattended. */
  autoDirtyReset: "merge:dirty-auto-reset",
  /** Lever `conflictAutoResolve` on → agent resolved the conflict, unattended. */
  autoConflictResolve: "merge:conflict-auto-resolved",
  /** Operator tapped "reset main & retry" (the lever-off half of dirtyAutoReset). */
  operatorDirtyReset: "merge:dirty-reset-retry",
  /** Operator tapped "apply resolution" (the lever-off half of conflictAutoResolve). */
  operatorConflictResolve: "merge:conflict-resolved",
  /** Operator tapped plain "approve" → a bare re-attempt of the merge. */
  operatorApprovedRetry: "merge:approved-retry",
  /** Operator hand-fixed the merge in a tmux intervention session. */
  manualIntervention: "merge:manual-intervention",
} as const;

/** The five resolution-path buckets the ops metric charts (feature plan mnx1zt27). */
export type MergeResolutionPath =
  | "auto_dirty_reset"
  | "auto_agent_resolve"
  | "operator_agent_resolve"
  | "manual_tmux"
  | "unresolved";

/**
 * Map a merge_failure decision row to its resolution-path bucket — a pure
 * function of `(status, outcome)`. `pending`/`dismissed` are unresolved (the work
 * is still stranded on its branch); an actioned row is classified by its
 * canonical outcome. An actioned row with a non-canonical outcome (a legacy row
 * from before every path stamped one) also falls to `unresolved` — the safe
 * default that keeps `total === Σ(paths)` exact.
 */
export function classifyMergeResolution(row: {
  status: string;
  outcome: string | null;
}): MergeResolutionPath {
  if (row.status === "pending" || row.status === "dismissed") return "unresolved";
  switch (row.outcome) {
    case MERGE_FAILURE_OUTCOME.autoDirtyReset:
      return "auto_dirty_reset";
    case MERGE_FAILURE_OUTCOME.autoConflictResolve:
      return "auto_agent_resolve";
    case MERGE_FAILURE_OUTCOME.operatorDirtyReset:
    case MERGE_FAILURE_OUTCOME.operatorConflictResolve:
    case MERGE_FAILURE_OUTCOME.operatorApprovedRetry:
      return "operator_agent_resolve";
    case MERGE_FAILURE_OUTCOME.manualIntervention:
      return "manual_tmux";
    default:
      return "unresolved";
  }
}

/**
 * The merge-remediation lever values captured on a merge_failure decision AT THE
 * TIME the failure was recorded (levers are operator-editable, so the value in
 * effect when the failure happened is the only honest one to attribute it to).
 * Persisted in the decision payload by {@link recordMergeFailure}.
 */
export interface MergeFailureLevers {
  dirtyAutoReset: boolean;
  conflictAutoResolve: boolean;
}

/**
 * Was the lever GOVERNING this failure's reason enabled when it happened? For a
 * `dirty` failure that's `dirtyAutoReset`; for a `conflict` it's
 * `conflictAutoResolve`; any other reason has no governing lever (→ off). This is
 * "the resolved lever value at the time" the ops metric buckets on.
 */
export function governingLeverOn(reason: string, levers: MergeFailureLevers | undefined): boolean {
  if (!levers) return false;
  if (reason === "dirty") return levers.dirtyAutoReset;
  if (reason === "conflict") return levers.conflictAutoResolve;
  return false;
}

/**
 * Shared helper for runs and ad-hoc sessions: when `mergeIntoMain` refuses
 * (conflict, dirty tree, etc.) record a `merge_failure` decision so the
 * operator gets the same recovery affordances regardless of source.
 *
 * Returns the decision id. Callers shape `payload` themselves so each
 * source can carry its own context (runId/sessionId/branch/etc.) without
 * a shared schema. Two fields are injected here centrally so the ops metric
 * (feature plan mnx1zt27) never depends on a caller remembering them: `reason`
 * (mirrors `params.reason`) and `levers` (the merge-remediation lever values in
 * effect right now — "the resolved lever value at the time").
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
  const merge = resolveAutonomyConfig(db, params.projectId).mergeRemediation;
  const levers: MergeFailureLevers = {
    dirtyAutoReset: merge.dirtyAutoReset,
    conflictAutoResolve: merge.conflictAutoResolve,
  };
  await db.insert(schema.decisions).values({
    id: decisionId,
    kind: "merge_failure",
    projectId: params.projectId,
    outcome: resolvedOutcome ?? `merge:${params.reason}`,
    payload: { ...params.payload, reason: params.reason, levers },
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
