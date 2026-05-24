import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";
import { useScopedChannel } from "../lib/use-channel.ts";

interface OpsSnapshot {
  running: Array<unknown>;
  queued: Array<unknown>;
  usage: {
    today: {
      inputTokens: number;
      outputTokens: number;
      totalCostUsd: number;
      pctOfDailyUsdCap: number | null;
    };
    rolling5h: {
      inputTokens: number;
      outputTokens: number;
      totalCostUsd: number;
      pctOfSessionTokensCap: number | null;
    };
    rolling7d: {
      inputTokens: number;
      outputTokens: number;
      totalCostUsd: number;
      pctOfWeeklyTokensCap: number | null;
    };
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
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Compact operational-awareness strip rendered in the app shell — running
 * count, today's tokens + cost, and rolling cap %s when caps are
 * configured. Click navigates to /ops for the full picture.
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
  const inT = usage.today.inputTokens;
  const outT = usage.today.outputTokens;
  const cost = usage.today.totalCostUsd;
  const sessionPct = usage.rolling5h.pctOfSessionTokensCap;
  const weeklyPct = usage.rolling7d.pctOfWeeklyTokensCap;

  const runningLabel =
    running.length > 0 ? (
      <span className="text-[var(--color-accent)]">{running.length} running</span>
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
      <span>
        ↑{fmtTokens(inT)} ↓{fmtTokens(outT)}
      </span>
      <span className="text-[var(--color-line)]">·</span>
      <span>{fmtCost(cost)}</span>
      {sessionPct != null || weeklyPct != null ? (
        <>
          <span className="text-[var(--color-line)]">·</span>
          {sessionPct != null ? <span>{Math.round(sessionPct)}% 5h</span> : null}
          {weeklyPct != null ? <span>{Math.round(weeklyPct)}% wk</span> : null}
        </>
      ) : null}
    </Link>
  );
}

/**
 * Mobile variant — single line under the header, taps through to /ops.
 * Compact-to-fit; drops meters when no caps configured.
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
  const cost = usage.today.totalCostUsd;
  const sessionPct = usage.rolling5h.pctOfSessionTokensCap;

  return (
    <Link
      to="/ops"
      className="md:hidden flex items-center justify-between px-4 h-7 border-b border-[var(--color-line)] bg-[var(--color-bg-1)]/60 mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-fg-2)] tabular-nums"
      aria-label="open ops dashboard"
    >
      <span className="flex items-center gap-2">
        <Activity size={10} className="text-[var(--color-fg-3)]" />
        {running.length > 0 ? (
          <span className="text-[var(--color-accent)]">{running.length} run</span>
        ) : (
          <span>idle</span>
        )}
        {queued.length > 0 ? <span>+{queued.length}q</span> : null}
      </span>
      <span className="flex items-center gap-2">
        <span>{fmtCost(cost)}</span>
        {sessionPct != null ? <span>{Math.round(sessionPct)}% 5h</span> : null}
      </span>
    </Link>
  );
}
