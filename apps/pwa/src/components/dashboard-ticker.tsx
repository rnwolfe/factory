import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";
import { useScopedChannel } from "../lib/use-channel.ts";

interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
}

interface OpsSnapshot {
  running: Array<unknown>;
  queued: Array<unknown>;
  usage: {
    today: UsageBucket;
    thisWeek: UsageBucket;
    thisMonth: UsageBucket;
  };
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(0)}`;
}

/**
 * Compact operational-awareness strip rendered in the app shell — running
 * count plus today's tokens + cost. Click navigates to /ops for the full
 * breakdown across today, this week, and this month windows.
 *
 * Subscribes to the global ops scope on `/ws/events`, so run lifecycle
 * events invalidate the snapshot live. A 30s refetchInterval is the
 * fallback for missed events (e.g. WS reconnect windows).
 */
export function DashboardTicker() {
  const snap = useQuery({
    queryKey: ["ops.snapshot"],
    queryFn: () => trpc.ops.snapshot.query() as unknown as Promise<OpsSnapshot>,
    refetchInterval: 30_000,
  });

  useScopedChannel({ kind: "ops", id: "" }, { invalidate: [["ops.snapshot"]] });

  if (!snap.data) return null;
  const { running, queued, usage } = snap.data;
  const { inputTokens: inT, outputTokens: outT, totalCostUsd: cost } = usage.today;

  const runningLabel =
    running.length > 0 ? (
      <span className="text-[var(--color-working)]">{running.length} running</span>
    ) : (
      <span>idle</span>
    );

  return (
    <Link
      to="/ops"
      className="hidden md:flex items-center gap-3 h-7 px-2.5 surface border border-[var(--color-line)] hover:border-[var(--color-line-bright)] hover:text-[var(--color-fg-1)] text-[var(--color-fg-2)] mono text-[10.5px] uppercase tracking-[0.14em] tabular-nums"
      aria-label="open ops dashboard"
      title="ops dashboard"
    >
      <Activity size={11} className="text-[var(--color-fg-3)]" />
      {runningLabel}
      {queued.length > 0 ? <span>+{queued.length}q</span> : null}
      <span className="text-[var(--color-line)]">·</span>
      <span>{fmtCost(cost)} today</span>
      <span className="text-[var(--color-line)]">·</span>
      <span>
        ↑{fmtTokens(inT)} ↓{fmtTokens(outT)}
      </span>
    </Link>
  );
}

/**
 * Mobile variant — single line under the header, taps through to /ops.
 * Drops the in/out tokens to fit narrower screens; shows today's $ only.
 */
export function DashboardTickerMobile() {
  const snap = useQuery({
    queryKey: ["ops.snapshot"],
    queryFn: () => trpc.ops.snapshot.query() as unknown as Promise<OpsSnapshot>,
    refetchInterval: 30_000,
  });

  useScopedChannel({ kind: "ops", id: "" }, { invalidate: [["ops.snapshot"]] });

  if (!snap.data) return null;
  const { running, queued, usage } = snap.data;

  return (
    <Link
      to="/ops"
      className="md:hidden flex items-center justify-between px-4 h-7 border-b border-[var(--color-line)] bg-[var(--color-bg-1)]/60 mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-fg-2)] tabular-nums"
      aria-label="open ops dashboard"
    >
      <span className="flex items-center gap-2">
        <Activity size={10} className="text-[var(--color-fg-3)]" />
        {running.length > 0 ? (
          <span className="text-[var(--color-working)]">{running.length} run</span>
        ) : (
          <span>idle</span>
        )}
        {queued.length > 0 ? <span>+{queued.length}q</span> : null}
      </span>
      <span>{fmtCost(usage.today.totalCostUsd)} today</span>
    </Link>
  );
}
