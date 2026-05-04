/**
 * Compact formatters for runtime cost / token / duration chips. Designed for
 * mono-text inline labels — no units when the unit is implied by the context.
 */

export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

export function fmtTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return rs > 0 ? `${m}m${rs}s` : `${m}m`;
}

export interface MetricsAggregate {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  invocations: number;
}

/**
 * Compose a single noninvasive chip label like "$0.18 · 4.2k tok · 23s".
 * Suppresses zero-cost rows (free or pre-metrics entities) by returning null
 * so the caller can render nothing rather than a $0 placeholder.
 */
export function chipLabel(m: MetricsAggregate): string | null {
  if (m.invocations === 0) return null;
  const total = m.inputTokens + m.outputTokens;
  if (m.totalCostUsd <= 0 && total <= 0) return null;
  const parts: string[] = [];
  if (m.totalCostUsd > 0) parts.push(fmtCost(m.totalCostUsd));
  if (total > 0) parts.push(`${fmtTokens(total)} tok`);
  if (m.durationMs > 0) parts.push(fmtDurationMs(m.durationMs));
  return parts.join(" · ");
}
