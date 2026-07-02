---
id: task-053
title: Pivot /metrics from cost-centric to token-centric (input/output up/down)
status: done
priority: med
estimate: small
created: 2026-06-21T03:25:00.186Z
updated: 2026-06-21T03:34:04.131Z
labels:
  - feedback
---

## Source

Captured from feedback k4clya133tf09wyci3e4j3z8 (metrics on /metrics?projectId=l0bbq6nns5rv8o5v2mrfqofq&range=30d&groupBy=agent).

## Operator's note

Can we center metrics around token up/down instead of dollars since codex doesn’t surface cost when using subscriptions. So move graphs, etc to token data. 

## Agent's draft

Rework `apps/pwa/src/routes/metrics.tsx` so token counts are the primary axis: change the daily `SpendChart` to plot input/output tokens (up/down split), flip headline KPIs and the per-project / per-agent / per-owner sort keys from `totalCostUsd` to token totals, and update `chipLabel` in `metrics-format.ts` to lead with tokens. Keep dollars as a secondary figure (still real for claude-code) but never let codex's hardcoded `$0` drive a chart or sort. No schema or daemon-query changes — token fields are already aggregated.

## Triage context

### Agent - 2026-06-21T03:20:08.563Z

Looked at how `/metrics` is wired. Good news: the token data you want is already there — every invocation records `inputTokens`/`outputTokens` (plus cache tokens) in the `claude_metrics` table, and the tRPC summary/daily queries already sum them. The reason dollars feels wrong for codex is concrete: `codex.ts` hardcodes `totalCostUsd: 0` because the ChatGPT-subscription CLI never returns a per-call cost, while `claude-code.ts` reads `total_cost_usd` from Anthropic's envelope. So today codex runs look free, which skews every cost chart and the by-agent grouping you were looking at.

So this is a presentation pivot, not a data change. The work is on `apps/pwa/src/routes/metrics.tsx`: make the daily chart plot tokens (input/output, ideally as an up/down split), flip the headline KPIs and the per-project/agent/owner sort keys from `totalCostUsd` to token totals, and update `chipLabel` in `metrics-format.ts` so the primary figure is tokens. My recommendation is to keep dollars as a *secondary* line rather than delete it — for claude-code it's still real and useful — but never let a $0 codex number drive a chart or a sort order.

One thing I'd want your call on when this gets picked up: "token up/down" — do you want input vs output split out as two series, or a single combined token total as the headline with the split available on drill-in? I'll default to input/output split on the chart since that's literally what you asked for, but flag it here so it's a conscious choice.

```json
{
  "kind": "task",
  "title": "Pivot /metrics from cost-centric to token-centric (input/output up/down)",
  "summary": "Rework `apps/pwa/src/routes/metrics.tsx` so token counts are the primary axis: change the daily `SpendChart` to plot input/output tokens (up/down split), flip headline KPIs and the per-project / per-agent / per-owner sort keys from `totalCostUsd` to token totals, and update `chipLabel` in `metrics-format.ts` to lead with tokens. Keep dollars as a secondary figure (still real for claude-code) but never let codex's hardcoded `$0` drive a chart or sort. No schema or daemon-query changes — token fields are already aggregated.",
  "reasoning": "It's a single coherent change confined to the metrics UI + one format helper — the token data is already captured and summed, so there's nothing to decompose, which rules out `plan`; and it's clearly actionable (the operator named the exact surface and the codex-subscription cause), which rules out `dismiss`."
}
```Looked at how `/metrics` is wired. Good news: the token data you want is already there — every invocation records `inputTokens`/`outputTokens` (plus cache tokens) in the `claude_metrics` table, and the tRPC summary/daily queries already sum them. The reason dollars feels wrong for codex is concrete: `codex.ts` hardcodes `totalCostUsd: 0` because the ChatGPT-subscription CLI never returns a per-call cost, while `claude-code.ts` reads `total_cost_usd` from Anthropic's envelope. So today codex runs look free, which skews every cost chart and the by-agent grouping you were looking at.

So this is a presentation pivot, not a data change. The work is on `apps/pwa/src/routes/metrics.tsx`: make the daily chart plot tokens (input/output, ideally as an up/down split), flip the headline KPIs and the per-project/agent/owner sort keys from `totalCostUsd` to token totals, and update `chipLabel` in `metrics-format.ts` so the primary figure is tokens. My recommendation is to keep dollars as a *secondary* line rather than delete it — for claude-code it's still real and useful — but never let a $0 codex number drive a chart or a sort order.

One thing I'd want your call on when this gets picked up: "token up/down" — do you want input vs output split out as two series, or a single combined token total as the headline with the split available on drill-in? I'll default to input/output split on the chart since that's literally what you asked for, but flag it here so it's a conscious choice.

```json
{
  "kind": "task",
  "title": "Pivot /metrics from cost-centric to token-centric (input/output up/down)",
  "summary": "Rework `apps/pwa/src/routes/metrics.tsx` so token counts are the primary axis: change the daily `SpendChart` to plot input/output tokens (up/down split), flip headline KPIs and the per-project / per-agent / per-owner sort keys from `totalCostUsd` to token totals, and update `chipLabel` in `metrics-format.ts` to lead with tokens. Keep dollars as a secondary figure (still real for claude-code) but never let codex's hardcoded `$0` drive a chart or sort. No schema or daemon-query changes — token fields are already aggregated.",
  "reasoning": "It's a single coherent change confined to the metrics UI + one format helper — the token data is already captured and summed, so there's nothing to decompose, which rules out `plan`; and it's clearly actionable (the operator named the exact surface and the codex-subscription cause), which rules out `dismiss`."
}
```

## Acceptance

- [ ] (TBD)

