import { type ClaudeMetricsOwnerKind, type Db, schema } from "@factory/db";
import type { AgentMetrics } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";

export interface RecordClaudeMetricsInput {
  db: Db;
  ownerKind: ClaudeMetricsOwnerKind;
  ownerId: string;
  /** Project this invocation contributes to; null for project-less calls (early triage). */
  projectId: string | null;
  metrics: AgentMetrics;
  now?: number;
}

/**
 * Persist a single `claude --print` invocation's result-envelope metrics. All
 * Factory call sites that shell out to Claude funnel through here so cost and
 * token usage roll up consistently. Idempotent at the row level — caller
 * generates a fresh id; double-record is safe but pointless.
 *
 * Best-effort: failures are logged and swallowed. Metrics being missing is
 * better than a metrics error sinking the actual run/audit/iteration the
 * caller is in the middle of.
 */
export async function recordClaudeMetrics(input: RecordClaudeMetricsInput): Promise<void> {
  try {
    await input.db.insert(schema.claudeMetrics).values({
      id: createId(),
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      projectId: input.projectId,
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
