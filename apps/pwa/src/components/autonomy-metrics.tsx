/**
 * AutonomyMetrics — the historical, read-only metrics block on the ops surface
 * (ADR-013 §4). First-class time-series charts in the dispatcher's-console
 * aesthetic: the north-star (decisions-per-run → 0) over time, throughput,
 * shipped work, the autonomy mix, and the Trust-Ladder auto-ratify rate —
 * per-project or portfolio, over a selectable window.
 *
 * Strictly awareness, never action: no links, no mutations (VISION — "not a
 * second inbox"). The catalog drives which charts can render; a small
 * presentation map below supplies human labels/colors. Empty/zero ranges
 * degrade to a quiet placeholder rather than a broken axis — the dev DB often
 * has no rollup rows until the daemon's cadence job has run.
 */

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  mergeSeries,
  rangeBounds,
  ratioSeries,
  rowsAllZero,
  type SeriesPoint,
} from "../lib/metric-series.ts";
import { trpc } from "../lib/trpc.ts";
import { MetricChart } from "./metric-chart.tsx";

// ── API shapes (mirrors metricsRouter; ADR-013 §3) ───────────────────────────

interface CatalogEntry {
  key: string;
  scope: "project" | "portfolio" | "both";
}

interface Snapshot {
  date: string | null;
  metrics: Record<string, number>;
  derived: { decisions_per_run: number; auto_ratify_rate: number };
}

// ── presentation map (labels only; existence is driven by the catalog) ───────

const PALETTE = {
  accent: "var(--color-accent)",
  working: "var(--color-working)", // teal — the autonomous voice; north-star trend
  green: "var(--color-verdict-greenlit)",
  amber: "var(--color-verdict-parked)",
  red: "var(--color-verdict-trashed)",
  blue: "var(--color-verdict-decompose)",
  neutral: "var(--color-fg-2)",
} as const;

type RangeKey = "7d" | "30d" | "90d";
const RANGE_DAYS: Record<RangeKey, number> = { "7d": 7, "30d": 30, "90d": 90 };

// Every series this block plots. `enabled` is gated on the live catalog so a
// retired metric simply stops charting — no code change.
const SERIES_METRICS = [
  "runs_total",
  "runs_completed",
  "decisions_total",
  "auto_ratified_total",
  "commits",
  "loc_added",
  "loc_removed",
  "projects_collaborative",
  "projects_autonomous",
] as const;
type SeriesMetric = (typeof SERIES_METRICS)[number];

// ── formatters ───────────────────────────────────────────────────────────────

function fmtDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtInt(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtRatio(v: number): string {
  return v.toFixed(2);
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// ── small UI atoms (match metrics.tsx / ops.tsx) ─────────────────────────────

function RangePill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "mono text-[9.5px] uppercase tracking-[0.14em] px-2 py-0.5 rounded transition-colors",
        active
          ? "text-[var(--color-fg-1)] border border-[var(--color-line-bright)]"
          : "text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function StatTile({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="surface p-3">
      <div className="mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {label}
      </div>
      <div
        className={[
          "mono tabular-nums mt-1 leading-none",
          emphasis
            ? "text-[26px] text-[var(--color-working)]"
            : "text-[20px] text-[var(--color-fg)]",
        ].join(" ")}
      >
        {value}
      </div>
      {hint ? (
        <div className="mono text-[9.5px] text-[var(--color-fg-3)] mt-1.5">{hint}</div>
      ) : null}
    </div>
  );
}

function ChartCard({
  title,
  legend,
  children,
}: {
  title: string;
  legend?: Array<{ label: string; color: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="surface p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          {title}
        </span>
        {legend ? (
          <div className="flex items-center gap-2.5">
            {legend.map((l) => (
              <span key={l.label} className="flex items-center gap-1">
                <span
                  className="w-2 h-2 rounded-sm"
                  style={{ backgroundColor: l.color }}
                  aria-hidden
                />
                <span className="mono text-[9px] text-[var(--color-fg-2)]">{l.label}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

export function AutonomyMetrics() {
  // Scope + range live in the URL so the operator's view survives a refresh and
  // is shareable — same pattern as the runtime metrics route.
  const [params, setParams] = useSearchParams();
  const range = ((): RangeKey => {
    const r = params.get("mrange");
    return r === "7d" || r === "90d" ? r : "30d";
  })();
  const scopeId = params.get("mscope") ?? "*";
  const onRange = (r: RangeKey) => {
    const p = new URLSearchParams(params);
    p.set("mrange", r);
    setParams(p, { replace: true });
  };
  const onScope = (id: string) => {
    const p = new URLSearchParams(params);
    p.set("mscope", id);
    setParams(p, { replace: true });
  };

  const isPortfolio = scopeId === "*";
  const { from, to } = useMemo(() => rangeBounds(RANGE_DAYS[range]), [range]);

  const catalogQ = useQuery({
    queryKey: ["metrics.catalog"],
    queryFn: () => trpc.metrics.catalog.query() as unknown as Promise<CatalogEntry[]>,
    staleTime: 5 * 60_000,
  });

  const projectsQ = useQuery({
    queryKey: ["projects.list"],
    queryFn: () =>
      trpc.projects.list.query() as unknown as Promise<Array<{ id: string; name: string }>>,
    staleTime: 60_000,
  });

  const snapQ = useQuery({
    queryKey: ["metrics.snapshot", scopeId],
    queryFn: () =>
      trpc.metrics.snapshot.query(
        isPortfolio ? undefined : { projectId: scopeId },
      ) as unknown as Promise<Snapshot>,
    refetchInterval: 60_000,
  });

  const catalog = catalogQ.data;
  const scopeOf = useMemo(() => {
    const m = new Map<string, CatalogEntry["scope"]>();
    for (const c of catalog ?? []) m.set(c.key, c.scope);
    return m;
  }, [catalog]);

  // A metric is queryable when the catalog knows it and its scope admits the
  // current scope (portfolio-only metrics don't chart for a single project).
  const queryable = (metric: string): boolean => {
    if (!catalog) return false; // wait for the catalog before firing series
    const s = scopeOf.get(metric);
    if (!s) return false;
    return isPortfolio ? s === "portfolio" || s === "both" : s === "project" || s === "both";
  };

  const seriesResults = useQueries({
    queries: SERIES_METRICS.map((metric) => ({
      queryKey: ["metrics.series", metric, scopeId, from, to],
      queryFn: () =>
        trpc.metrics.series.query({
          metric,
          projectId: isPortfolio ? undefined : scopeId,
          from,
          to,
        }) as unknown as Promise<SeriesPoint[]>,
      enabled: queryable(metric),
      refetchInterval: 60_000,
      staleTime: 30_000,
    })),
  });

  const series = useMemo(() => {
    const out = {} as Record<SeriesMetric, SeriesPoint[] | undefined>;
    SERIES_METRICS.forEach((m, i) => {
      out[m] = seriesResults[i]?.data;
    });
    return out;
  }, [seriesResults]);

  // ── derived chart tables ──
  const dprRows = useMemo(
    () => ratioSeries(series.decisions_total, series.runs_total),
    [series.decisions_total, series.runs_total],
  );
  const ratifyRows = useMemo(
    () => ratioSeries(series.auto_ratified_total, series.decisions_total),
    [series.auto_ratified_total, series.decisions_total],
  );
  const throughputRows = useMemo(
    () => mergeSeries([{ key: "runs_completed", rows: series.runs_completed }]),
    [series.runs_completed],
  );
  const commitRows = useMemo(
    () => mergeSeries([{ key: "commits", rows: series.commits }]),
    [series.commits],
  );
  const locRows = useMemo(
    () =>
      mergeSeries([
        { key: "loc_added", rows: series.loc_added },
        { key: "loc_removed", rows: series.loc_removed },
      ]),
    [series.loc_added, series.loc_removed],
  );
  const mixRows = useMemo(
    () =>
      mergeSeries([
        { key: "projects_collaborative", rows: series.projects_collaborative },
        { key: "projects_autonomous", rows: series.projects_autonomous },
      ]),
    [series.projects_collaborative, series.projects_autonomous],
  );

  const snap = snapQ.data;
  const m = snap?.metrics ?? {};
  const projects = projectsQ.data ?? [];
  const scopeName = isPortfolio
    ? "portfolio"
    : (projects.find((p) => p.id === scopeId)?.name ?? "project");

  return (
    <section className="space-y-3">
      {/* Section header + controls */}
      <div className="flex items-center gap-2 px-1 flex-wrap">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          autonomy
        </span>
        <div className="hairline flex-1 min-w-[12px]" />
        <select
          value={scopeId}
          onChange={(e) => onScope(e.target.value)}
          aria-label="metrics scope"
          className="mono text-[10px] bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-0.5 text-[var(--color-fg-1)] max-w-[160px]"
        >
          <option value="*">portfolio</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          {(Object.keys(RANGE_DAYS) as RangeKey[]).map((r) => (
            <RangePill key={r} label={r} active={range === r} onClick={() => onRange(r)} />
          ))}
        </div>
      </div>

      {/* Headline snapshot tiles (latest rolled-up day) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatTile
          label="decisions / run"
          value={snap ? fmtRatio(snap.derived.decisions_per_run) : "—"}
          hint="north-star → 0"
          emphasis
        />
        <StatTile label="auto-ratify" value={snap ? fmtPct(snap.derived.auto_ratify_rate) : "—"} />
        <StatTile label="runs" value={fmtInt(m.runs_total ?? 0)} hint={scopeName} />
        <StatTile label="commits" value={fmtInt(m.commits ?? 0)} hint="merged · latest day" />
      </div>

      {/* North-star: decisions-per-run over time (full width) */}
      <ChartCard title="decisions per run · over time">
        <MetricChart
          data={dprRows}
          series={[{ key: "value", label: "decisions/run", color: PALETTE.working, kind: "line" }]}
          height={180}
          formatX={fmtDay}
          formatY={fmtRatio}
          empty={rowsAllZero(dprRows, ["value"])}
          emptyLabel="no runs in this range yet"
        />
      </ChartCard>

      {/* Two-up grid: throughput, commits, lines changed, auto-ratify */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <ChartCard title="throughput · runs completed / day">
          <MetricChart
            data={throughputRows}
            series={[{ key: "runs_completed", label: "completed", color: PALETTE.green }]}
            formatX={fmtDay}
            formatY={fmtInt}
            empty={rowsAllZero(throughputRows, ["runs_completed"])}
          />
        </ChartCard>

        <ChartCard title="commits / day">
          <MetricChart
            data={commitRows}
            series={[{ key: "commits", label: "commits", color: PALETTE.neutral }]}
            formatX={fmtDay}
            formatY={fmtInt}
            empty={rowsAllZero(commitRows, ["commits"])}
          />
        </ChartCard>

        <ChartCard
          title="lines changed / day"
          legend={[
            { label: "added", color: PALETTE.green },
            { label: "removed", color: PALETTE.red },
          ]}
        >
          <MetricChart
            data={locRows}
            series={[
              { key: "loc_added", label: "added", color: PALETTE.green },
              { key: "loc_removed", label: "removed", color: PALETTE.red },
            ]}
            formatX={fmtDay}
            formatY={fmtInt}
            empty={rowsAllZero(locRows, ["loc_added", "loc_removed"])}
          />
        </ChartCard>

        <ChartCard title="auto-ratify rate · over time">
          <MetricChart
            data={ratifyRows}
            series={[{ key: "value", label: "auto-ratify", color: PALETTE.blue, kind: "line" }]}
            formatX={fmtDay}
            formatY={fmtPct}
            formatValue={fmtPct}
            empty={rowsAllZero(ratifyRows, ["value"])}
            emptyLabel="no decisions in this range yet"
          />
        </ChartCard>
      </div>

      {/* Autonomy mix — portfolio-only (projects_* are portfolio snapshots) */}
      {isPortfolio ? (
        <ChartCard
          title="autonomy mix · projects"
          legend={[
            { label: "collaborative", color: PALETTE.amber },
            { label: "autonomous", color: PALETTE.green },
          ]}
        >
          <MetricChart
            data={mixRows}
            series={[
              {
                key: "projects_collaborative",
                label: "collaborative",
                color: PALETTE.amber,
                stacked: true,
              },
              {
                key: "projects_autonomous",
                label: "autonomous",
                color: PALETTE.green,
                stacked: true,
              },
            ]}
            formatX={fmtDay}
            formatY={fmtInt}
            empty={rowsAllZero(mixRows, ["projects_collaborative", "projects_autonomous"])}
          />
        </ChartCard>
      ) : null}

      <p className="mono text-[9.5px] text-[var(--color-fg-3)] px-1">
        read-only · rolled-up daily · merged-to-main work · {from} → {to}
      </p>
    </section>
  );
}
