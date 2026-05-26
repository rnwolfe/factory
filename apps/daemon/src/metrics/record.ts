import { type ClaudeMetricsOwnerKind, type Db, schema } from "@factory/db";
import type { AgentMetrics } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";

export interface RecordAgentMetricsInput {
  db: Db;
  ownerKind: ClaudeMetricsOwnerKind;
  ownerId: string;
  /** Project this invocation contributes to; null for project-less calls (early triage). */
  projectId: string | null;
  /**
   * Canonical agent id from the registry (claude-code | codex | …). Passed
   * explicitly because the metrics envelope's `model` field alone is
   * ambiguous in principle (codex-tuned variants of GPT models could one
   * day share a prefix with regular GPT). Persisting the agent lets per-
   * harness aggregation be a direct column read rather than a fragile
   * model-id-prefix inference at query time.
   */
  agent: string;
  metrics: AgentMetrics;
  now?: number;
}

/**
 * Persist a single headless-agent invocation's result-envelope metrics. All
 * Factory call sites that shell out to a headless agent (claude --print,
 * codex exec, future harnesses) funnel through here so cost and token usage
 * roll up consistently. Idempotent at the row level — caller generates a
 * fresh id; double-record is safe but pointless.
 *
 * Best-effort: failures are logged and swallowed. Metrics being missing is
 * better than a metrics error sinking the actual run/audit/iteration the
 * caller is in the middle of.
 *
 * Storage table is still named `claude_metrics` (historical, pre-codex name)
 * — operator-visible naming on the interface side stays agent-neutral.
 */
export async function recordAgentMetrics(input: RecordAgentMetricsInput): Promise<void> {
  try {
    await input.db.insert(schema.claudeMetrics).values({
      id: createId(),
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      projectId: input.projectId,
      agent: input.agent,
      model: input.metrics.model,
      modelUsage: JSON.stringify(input.metrics.modelUsage ?? {}),
      totalCostUsd: input.metrics.totalCostUsd,
      inputTokens: input.metrics.inputTokens,
      outputTokens: input.metrics.outputTokens,
      cacheCreationTokens: input.metrics.cacheCreationTokens,
      cacheReadTokens: input.metrics.cacheReadTokens,
      durationMs: input.metrics.durationMs,
      durationApiMs: input.metrics.durationApiMs,
      numTurns: input.metrics.numTurns,
      sessionId: input.metrics.sessionId,
      isError: input.metrics.isError,
      subtype: input.metrics.subtype,
      createdAt: input.now ?? Date.now(),
    });
  } catch (err) {
    console.warn(
      `[metrics] failed to record ${input.ownerKind}/${input.ownerId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** @deprecated Legacy alias for {@link recordAgentMetrics}; new code should use the agent-neutral name. */
export const recordClaudeMetrics = recordAgentMetrics;
/** @deprecated Legacy alias for {@link RecordAgentMetricsInput}. */
export type RecordClaudeMetricsInput = RecordAgentMetricsInput;
