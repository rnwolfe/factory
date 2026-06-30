import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, TrendingUp } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AutonomyMetrics } from "../components/autonomy-metrics.tsx";
import { type ChartSeries, MetricChart } from "../components/metric-chart.tsx";
import { WatchPanel } from "../components/watch-panel.tsx";
import type { ChartRow } from "../lib/metric-series.ts";
import { chipLabel, fmtCost, fmtTokens, type MetricsAggregate } from "../lib/metrics-format.ts";
import { trpc } from "../lib/trpc.ts";

// ---- Types ----

interface SummaryRow extends MetricsAggregate {
  ownerKind?: string;
  projectId?: string | null;
}

interface SummaryResponse {
  totals: MetricsAggregate;
  byProject: Array<MetricsAggregate & { projectId: string | null }>;
  byOwnerKind: Array<MetricsAggregate & { ownerKind: string }>;
}

interface DailyBucket {
  day: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  invocations: number;
  runCount: number;
}

interface DailySeries {
  key: string | null;
  buckets: DailyBucket[];
}

interface DailyResponse {
  days: string[];
  series: DailySeries[];
}

type RangePeriod = "7d" | "30d" | "90d";
type GroupByMode = "project" | "agent" | "agent+model" | "model" | "total";

interface RuntimeResponse {
  totals: { wallClockMs: number; apiMs: number; runCount: number };
  byProject: Array<{ projectId: string | null; wallClockMs: number; runCount: number }>;
  byAgent: Array<{ agent: string | null; wallClockMs: number; runCount: number }>;
}

function fmtHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 100) return `${hours.toFixed(0)}h`;
  if (hours >= 10) return `${hours.toFixed(1)}h`;
  if (hours >= 1) return `${hours.toFixed(2)}h`;
  const minutes = ms / 60_000;
  if (minutes >= 1) return `${minutes.toFixed(0)}m`;
  return `${(ms / 1000).toFixed(0)}s`;
}

function tokensOf(r: MetricsAggregate): number {
  return r.inputTokens + r.outputTokens;
}

function agentLabel(id: string | null): string {
  if (id === null) return "(unattributed)";
  if (id === "claude-code") return "claude";
  if (id === "codex") return "codex";
  return id;
}

// ---- Constants ----

const OWNER_KIND_LABEL: Record<string, string> = {
  run: "code-changing runs",
  audit: "audits (read-only)",
  audit_exec: "audits (exec)",
  plan_iteration: "plan iteration",
  triage: "triage",
  audit_promote: "audit → promote bridge",
  audit_comment: "audit follow-ups",
};

const SERIES_COLORS = [
  "hsl(22 88% 60%)",
  "hsl(220 55% 70%)",
  "hsl(140 42% 58%)",
  "hsl(40 70% 60%)",
  "hsl(0 55% 58%)",
  "hsl(280 45% 65%)",
  "hsl(180 45% 60%)",
  "hsl(60 70% 55%)",
];

// ---- Chart helpers ----

const CHART_H = 150;

function computeRange(period: RangePeriod): { startIso: string; endIso: string } {
  const now = Date.now();
  const daysBack = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  return {
    startIso: new Date(now - daysBack * 86_400_000).toISOString(),
    endIso: new Date(now).toISOString(),
  };
}

function fmtAxisTokens(tokens: number): string {
  if (tokens <= 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${Math.round(tokens)}`;
}

function fmtAxisDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

function seriesLabel(
  key: string | null,
  groupBy: GroupByMode,
  projectName: Map<string, string>,
): string {
  if (key === null) return groupBy === "project" ? "unattributed" : "unknown";
  if (groupBy === "project") {
    const n = projectName.get(key);
    return n ? n.slice(0, 20) : key.slice(0, 8);
  }
  if (groupBy === "agent") {
    return agentLabel(key);
  }
  if (groupBy === "agent+model") {
    // Composite key from the daily query: `"<agent>||<model>"`. Render
    // `agent · model` so the legend stays scannable.
    const [agent = "", model = ""] = key.split("||");
    if (!agent && !model) return "(unattributed)";
    if (!model) return agentLabel(agent);
    const prettyModel = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
    return `${agentLabel(agent)} · ${prettyModel}`;
  }
  return key
    .replace(/claude-/g, "")
    .replace(/-\d{8}$/, "")
    .slice(0, 20);
}

// ---- Diverging stacked-bar token chart (input ↑ / output ↓) ----

// Each day is a diverging bar: input tokens stack upward from the zero
// baseline, output tokens stack downward, grouped by series. Both halves of a
// series share one color (input full-opacity, output dimmed) so the legend
// stays one swatch per series. The diverging split is free: output values are
// negated and `MetricChart`'s `stackOffset="sign"` pushes them below the axis.
// Tokens — not dollars — drive the chart: codex on a ChatGPT subscription
// reports $0, so a cost axis would render every codex day as empty.
function SpendChart({
  days,
  series,
  groupBy,
  projectName,
}: {
  days: string[];
  series: DailySeries[];
  groupBy: GroupByMode;
  projectName: Map<string, string>;
}) {
  const { rows, chartSeries } = useMemo(() => {
    const rows: ChartRow[] = days.map((day, di) => {
      const row: ChartRow = { date: day };
      series.forEach((ser, si) => {
        row[`s${si}_in`] = ser.buckets[di]?.inputTokens ?? 0;
        row[`s${si}_out`] = -(ser.buckets[di]?.outputTokens ?? 0);
      });
      return row;
    });
    const chartSeries: ChartSeries[] = series.flatMap((ser, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length] ?? "hsl(22 88% 60%)";
      const label = seriesLabel(ser.key, groupBy, projectName);
      return [
        {
          key: `s${si}_in`,
          label: `${label} · in`,
          color,
          kind: "bar" as const,
          stacked: true,
          fillOpacity: 0.9,
        },
        {
          key: `s${si}_out`,
          label: `${label} · out`,
          color,
          kind: "bar" as const,
          stacked: true,
          fillOpacity: 0.5,
        },
      ];
    });
    return { rows, chartSeries };
  }, [days, series, groupBy, projectName]);

  if (days.length === 0) return null;

  return (
    <MetricChart
      data={rows}
      series={chartSeries}
      height={CHART_H}
      formatX={fmtAxisDate}
      formatY={(v) => fmtAxisTokens(Math.abs(v))}
      formatValue={(v) => `${fmtAxisTokens(Math.abs(v))} tok`}
    />
  );
}

// ---- Sub-components ----

function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 mb-1.5">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </span>
      <div className="hairline flex-1" />
      {right}
    </div>
  );
}

function HeadlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {label}
      </span>
      <span className="mono text-[22px] leading-tight text-[var(--color-fg)] tabular-nums">
        {value}
      </span>
    </div>
  );
}

function PillButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
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

function ChartLegend({
  series,
  groupBy,
  projectName,
}: {
  series: DailySeries[];
  groupBy: GroupByMode;
  projectName: Map<string, string>;
}) {
  if (series.length <= 1 && series[0]?.key === null) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 mt-2">
      {series.map((s, i) => (
        <div key={s.key ?? "_null"} className="flex items-center gap-1.5">
          <div
            className="w-2 h-2 rounded-sm flex-shrink-0"
            style={{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }}
          />
          <span className="mono text-[9.5px] text-[var(--color-fg-2)]">
            {seriesLabel(s.key, groupBy, projectName)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProjectRow({ row, name }: { row: SummaryRow; name: string }) {
  const tokens = row.inputTokens + row.outputTokens;
  const inner =
    row.projectId !== null && row.projectId !== undefined ? (
      <Link
        to={`/projects/${row.projectId}`}
        className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
      >
        <RowBody
          name={name}
          cost={row.totalCostUsd}
          tokens={tokens}
          invocations={row.invocations}
        />
      </Link>
    ) : (
      <div className="px-3 py-2.5">
        <RowBody
          name={name}
          cost={row.totalCostUsd}
          tokens={tokens}
          invocations={row.invocations}
        />
      </div>
    );
  return <li>{inner}</li>;
}

function KindRow({ row, label }: { row: SummaryRow; label: string }) {
  const tokens = row.inputTokens + row.outputTokens;
  return (
    <li>
      <div className="px-3 py-2.5">
        <RowBody
          name={label}
          cost={row.totalCostUsd}
          tokens={tokens}
          invocations={row.invocations}
        />
      </div>
    </li>
  );
}

function RowBody({
  name,
  cost,
  tokens,
  invocations,
}: {
  name: string;
  cost: number;
  tokens: number;
  invocations: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[13.5px] text-[var(--color-fg)] truncate flex-1">{name}</span>
      <span className="mono text-[11px] text-[var(--color-fg-2)] tabular-nums w-[68px] text-right">
        {fmtTokens(tokens)} tok
      </span>
      <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums w-[56px] text-right">
        {fmtCost(cost)}
      </span>
      <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums w-[44px] text-right">
        ×{invocations}
      </span>
    </div>
  );
}

// ---- Main export ----

function toApiGroupBy(g: GroupByMode): "project" | "model" | "agent" | "agent+model" | "none" {
  return g === "total" ? "none" : g;
}

export function Metrics() {
  const [searchParams, setSearchParams] = useSearchParams();

  const range = (searchParams.get("range") ?? "30d") as RangePeriod;
  const groupBy = (searchParams.get("groupBy") ?? "project") as GroupByMode;

  const setRange = (next: RangePeriod) => {
    const p = new URLSearchParams(searchParams);
    p.set("range", next);
    setSearchParams(p, { replace: true });
  };

  const setGroupBy = (next: GroupByMode) => {
    const p = new URLSearchParams(searchParams);
    p.set("groupBy", next);
    setSearchParams(p, { replace: true });
  };

  const chartQ = useQuery({
    queryKey: ["metrics.daily.chart", range, groupBy],
    queryFn: () => {
      const { startIso, endIso } = computeRange(range);
      return trpc.metrics.daily.query({
        start: startIso,
        end: endIso,
        groupBy: toApiGroupBy(groupBy),
      }) as unknown as Promise<DailyResponse>;
    },
    refetchInterval: 60_000,
  });

  const totalsQ = useQuery({
    queryKey: ["metrics.daily.totals", range],
    queryFn: () => {
      const { startIso, endIso } = computeRange(range);
      return trpc.metrics.daily.query({
        start: startIso,
        end: endIso,
        groupBy: "none",
      }) as unknown as Promise<DailyResponse>;
    },
    refetchInterval: 60_000,
  });

  const summary = useQuery({
    queryKey: ["metrics.summary"],
    queryFn: () => trpc.metrics.summary.query() as unknown as Promise<SummaryResponse>,
    refetchInterval: 30_000,
  });

  const runtimeQ = useQuery({
    queryKey: ["metrics.runtime"],
    queryFn: () =>
      (
        trpc.metrics as unknown as {
          runtime: { query: () => Promise<RuntimeResponse> };
        }
      ).runtime.query(),
    refetchInterval: 60_000,
  });

  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () =>
      trpc.projects.list.query() as unknown as Promise<Array<{ id: string; name: string }>>,
  });

  const projectName = useMemo(
    () => new Map(projects.data?.map((p) => [p.id, p.name]) ?? []),
    [projects.data],
  );

  const headlines = useMemo(() => {
    const s = totalsQ.data?.series?.[0];
    if (!s) return null;
    const totalInput = s.buckets.reduce((sum, b) => sum + b.inputTokens, 0);
    const totalOutput = s.buckets.reduce((sum, b) => sum + b.outputTokens, 0);
    const totalCost = s.buckets.reduce((sum, b) => sum + b.totalCostUsd, 0);
    const totalRuns = s.buckets.reduce((sum, b) => sum + b.runCount, 0);
    const totalTokens = totalInput + totalOutput;
    const avgTokensPerRun = totalRuns > 0 ? totalTokens / totalRuns : 0;
    return { totalInput, totalOutput, totalTokens, totalCost, totalRuns, avgTokensPerRun };
  }, [totalsQ.data]);

  const chartState = useMemo((): "loading" | "empty" | "degraded" | "normal" => {
    if (totalsQ.isLoading) return "loading";
    const s = totalsQ.data?.series?.[0];
    if (!s) return "empty";
    if (!s.buckets.some((b) => b.invocations > 0)) return "empty";
    if (!s.buckets.some((b) => b.inputTokens > 0 || b.outputTokens > 0)) return "degraded";
    return "normal";
  }, [totalsQ.isLoading, totalsQ.data]);

  const summaryData = summary.data;
  const sortedProjects = useMemo(
    () => (summaryData ? [...summaryData.byProject].sort((a, b) => tokensOf(b) - tokensOf(a)) : []),
    [summaryData],
  );
  const sortedKinds = useMemo(
    () =>
      summaryData ? [...summaryData.byOwnerKind].sort((a, b) => tokensOf(b) - tokensOf(a)) : [],
    [summaryData],
  );

  const rangeLabel =
    range === "7d" ? "last 7 days" : range === "90d" ? "last 90 days" : "last 30 days";

  return (
    <div className="space-y-3 pb-4 md:max-w-5xl md:mx-auto">
      {/* Header */}
      <header className="surface p-4">
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
        >
          <ArrowLeft size={11} /> settings
        </Link>
        <h1 className="display text-[20px] leading-snug text-[var(--color-fg)] mt-2">
          runtime metrics
        </h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
          Token throughput (input ↑ / output ↓), wall-clock runtime, and cost across every agent
          invocation Heimdall has driven — drillable by project, agent, and model.
        </p>
        {runtimeQ.data ? (
          <div className="mt-4 grid grid-cols-3 gap-3">
            <HeadlineStat
              label="agent work (all time)"
              value={fmtHours(runtimeQ.data.totals.wallClockMs)}
            />
            <HeadlineStat label="api time" value={fmtHours(runtimeQ.data.totals.apiMs)} />
            <HeadlineStat label="runs completed" value={String(runtimeQ.data.totals.runCount)} />
          </div>
        ) : null}
      </header>

      {/* Range spend section */}
      <section>
        <SectionHeader
          title="tokens"
          right={
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                {(["7d", "30d", "90d"] as const).map((p) => (
                  <PillButton key={p} label={p} active={range === p} onClick={() => setRange(p)} />
                ))}
              </div>
              <div className="w-px h-3 bg-[var(--color-line)]" />
              <div className="flex gap-1 flex-wrap">
                {(["project", "agent", "agent+model", "model", "total"] as const).map((g) => (
                  <PillButton
                    key={g}
                    label={g}
                    active={groupBy === g}
                    onClick={() => setGroupBy(g)}
                  />
                ))}
              </div>
            </div>
          }
        />

        {/* Headline numerals */}
        {chartState === "loading" ? (
          <div className="surface p-4 grid grid-cols-3 gap-3">
            <div className="skel h-10 rounded" />
            <div className="skel h-10 rounded" />
            <div className="skel h-10 rounded" />
          </div>
        ) : (
          <div className="surface p-4">
            <div className="grid grid-cols-3 gap-3">
              <HeadlineStat
                label="tokens in ↑"
                value={headlines ? fmtTokens(headlines.totalInput) : "0"}
              />
              <HeadlineStat
                label="tokens out ↓"
                value={headlines ? fmtTokens(headlines.totalOutput) : "0"}
              />
              <HeadlineStat label="runs" value={headlines ? String(headlines.totalRuns) : "0"} />
            </div>
            <p className="mono text-[10px] text-[var(--color-fg-3)] mt-3">
              {headlines ? fmtTokens(headlines.totalTokens) : "0"} tok total
              {headlines?.totalRuns ? ` · ${fmtTokens(headlines.avgTokensPerRun)} tok/run` : ""} · ≈
              {headlines ? fmtCost(headlines.totalCost) : "$0"} billed (claude-code only; codex runs
              on a subscription)
            </p>
          </div>
        )}

        {/* Chart area */}
        <div className="surface mt-2 p-3 overflow-hidden">
          {chartState === "loading" ? (
            <div className="skel rounded" style={{ height: CHART_H }} />
          ) : chartState === "empty" ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <TrendingUp size={24} className="text-[var(--color-fg-3)]" />
              <div className="display text-[15px] text-[var(--color-fg-2)]">no activity</div>
              <p className="mono text-[10.5px] text-[var(--color-fg-3)] text-center max-w-[220px]">
                no runs recorded in the {rangeLabel} · try a wider range or kick off a task
              </p>
            </div>
          ) : chartState === "degraded" ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <div className="display text-[15px] text-[var(--color-fg-2)]">
                token data unavailable
              </div>
              <p className="mono text-[10.5px] text-[var(--color-fg-3)] text-center max-w-[260px]">
                {headlines?.totalRuns ?? 0} runs recorded in the {rangeLabel} but no token figures
                were captured · rows may pre-date metrics tracking
              </p>
            </div>
          ) : chartQ.data ? (
            <>
              <SpendChart
                days={chartQ.data.days}
                series={chartQ.data.series}
                groupBy={groupBy}
                projectName={projectName}
              />
              <ChartLegend
                series={chartQ.data.series}
                groupBy={groupBy}
                projectName={projectName}
              />
            </>
          ) : null}
        </div>
      </section>

      {/* All-time breakdown: by project */}
      <section>
        <SectionHeader title="by project (all time)" />
        {summary.isLoading ? (
          <div className="surface p-3 mono text-[12px] text-[var(--color-fg-3)]">loading…</div>
        ) : sortedProjects.length === 0 ? (
          <div className="surface px-3 py-3 text-[12.5px] text-[var(--color-fg-3)]">
            no project-attributed invocations yet.
          </div>
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {sortedProjects.map((row) => (
              <ProjectRow
                key={row.projectId ?? "unattributed"}
                row={row}
                name={
                  row.projectId
                    ? (projectName.get(row.projectId) ?? row.projectId)
                    : "(unattributed)"
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* All-time breakdown: by agent */}
      <section>
        <SectionHeader title="by agent (all time)" />
        {runtimeQ.isLoading ? (
          <div className="surface p-3 mono text-[12px] text-[var(--color-fg-3)]">loading…</div>
        ) : !runtimeQ.data || runtimeQ.data.byAgent.length === 0 ? (
          <div className="surface px-3 py-3 text-[12.5px] text-[var(--color-fg-3)]">
            no runs recorded yet.
          </div>
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {[...runtimeQ.data.byAgent]
              .sort((a, b) => b.wallClockMs - a.wallClockMs)
              .map((row) => (
                <li key={row.agent ?? "_null"}>
                  <div className="px-3 py-2.5 flex items-center gap-3">
                    <span className="text-[13.5px] text-[var(--color-fg)] truncate flex-1">
                      {agentLabel(row.agent)}
                    </span>
                    <span className="mono text-[11px] text-[var(--color-fg-2)] tabular-nums">
                      {fmtHours(row.wallClockMs)}
                    </span>
                    <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums w-[44px] text-right">
                      ×{row.runCount}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>

      {/* All-time breakdown: by owner kind */}
      <section>
        <SectionHeader title="by owner kind (all time)" />
        {summary.isLoading ? (
          <div className="surface p-3 mono text-[12px] text-[var(--color-fg-3)]">loading…</div>
        ) : sortedKinds.length === 0 ? (
          <div className="surface px-3 py-3 text-[12.5px] text-[var(--color-fg-3)]">
            no recorded invocations yet.
          </div>
        ) : (
          <ul className="surface divide-y divide-[var(--color-line)]">
            {sortedKinds.map((row) => (
              <KindRow
                key={row.ownerKind}
                label={OWNER_KIND_LABEL[row.ownerKind] ?? row.ownerKind}
                row={row}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Historical autonomy / throughput charts — the natural home for the
          north-star (decisions-per-run → 0) and friends, shared with /ops. */}
      <div className="pt-1">
        <AutonomyMetrics />
      </div>

      {/* The Watch — observability for the out-of-band synthesis loop. */}
      <WatchPanel />
    </div>
  );
}

// Re-export for convenience so other components can render compact metric chips.
export { chipLabel };
