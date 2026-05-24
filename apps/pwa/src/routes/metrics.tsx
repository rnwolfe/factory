import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, TrendingUp } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
type GroupByMode = "project" | "model";

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

const SVG_W = 400;
const SVG_H = 150;
const PAD = { l: 36, r: 4, t: 8, b: 22 };
const CHART_W = SVG_W - PAD.l - PAD.r;
const CHART_H = SVG_H - PAD.t - PAD.b;

function computeRange(period: RangePeriod): { startIso: string; endIso: string } {
  const now = Date.now();
  const daysBack = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  return {
    startIso: new Date(now - daysBack * 86_400_000).toISOString(),
    endIso: new Date(now).toISOString(),
  };
}

function computeYTicks(max: number): number[] {
  if (max <= 0) return [];
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  let step = base;
  let iter = 0;
  while (Math.floor(max / step) < 3 && iter++ < 20) step /= 2;
  while (Math.floor(max / step) > 6 && iter++ < 40) step *= 2;
  const ticks: number[] = [];
  let t = step;
  while (t <= max * 1.001 && ticks.length < 5) {
    ticks.push(Number.parseFloat(t.toPrecision(2)));
    t += step;
  }
  return ticks;
}

function fmtAxisCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(0)}`;
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
  return key
    .replace(/claude-/g, "")
    .replace(/-\d{8}$/, "")
    .slice(0, 20);
}

// ---- SVG stacked-bar chart ----

function SpendChart({ days, series }: { days: string[]; series: DailySeries[] }) {
  const n = days.length;
  if (n === 0) return null;

  const slotW = CHART_W / n;
  const barW = Math.max(1.5, slotW * 0.82);
  const dailyTotals = days.map((_, di) =>
    series.reduce((s, ser) => s + (ser.buckets[di]?.totalCostUsd ?? 0), 0),
  );
  const maxTotal = Math.max(...dailyTotals, 1e-9);
  const yTicks = computeYTicks(maxTotal);
  const labelEvery = n <= 7 ? 1 : n <= 31 ? 5 : 15;

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-full h-auto"
      aria-label="Daily spend chart"
      style={{ fontFamily: "Geist Mono, monospace" }}
    >
      {/* Grid lines + y-axis labels */}
      {yTicks.map((tick) => {
        const y = PAD.t + CHART_H - (tick / maxTotal) * CHART_H;
        return (
          <g key={tick}>
            <line
              x1={PAD.l}
              y1={y}
              x2={SVG_W - PAD.r}
              y2={y}
              stroke="hsl(30 5% 22%)"
              strokeWidth={0.5}
              strokeDasharray="2 3"
            />
            <text x={PAD.l - 3} y={y + 3.5} textAnchor="end" fontSize={9} fill="hsl(30 8% 42%)">
              {fmtAxisCost(tick)}
            </text>
          </g>
        );
      })}

      {/* Baseline */}
      <line
        x1={PAD.l}
        y1={PAD.t + CHART_H}
        x2={SVG_W - PAD.r}
        y2={PAD.t + CHART_H}
        stroke="hsl(30 5% 22%)"
        strokeWidth={0.75}
      />

      {/* Stacked bars */}
      {days.map((day, di) => {
        const x = PAD.l + di * slotW + (slotW - barW) / 2;
        const segs: Array<{ si: number; barH: number; barY: number }> = [];
        let yOff = 0;
        for (let si = 0; si < series.length; si++) {
          const val = series[si]?.buckets[di]?.totalCostUsd ?? 0;
          if (val <= 0) continue;
          const barH = (val / maxTotal) * CHART_H;
          segs.push({ si, barH, barY: PAD.t + CHART_H - yOff - barH });
          yOff += barH;
        }
        return (
          <g key={day}>
            {segs.map(({ si, barH, barY }) => (
              <rect
                key={series[si]?.key ?? "_null"}
                x={x}
                y={barY}
                width={barW}
                height={barH}
                fill={SERIES_COLORS[si % SERIES_COLORS.length]}
                opacity={0.88}
              />
            ))}
          </g>
        );
      })}

      {/* X-axis labels */}
      {days.map((day, di) => {
        if (di % labelEvery !== 0) return null;
        return (
          <text
            key={day}
            x={PAD.l + di * slotW + slotW / 2}
            y={SVG_H - 5}
            textAnchor="middle"
            fontSize={9}
            fill="hsl(30 8% 42%)"
          >
            {fmtAxisDate(day)}
          </text>
        );
      })}
    </svg>
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
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] border border-[var(--color-accent-line)]"
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
      <span className="mono text-[11px] text-[var(--color-fg-2)] tabular-nums">
        {fmtCost(cost)}
      </span>
      <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums w-[68px] text-right">
        {fmtTokens(tokens)} tok
      </span>
      <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums w-[44px] text-right">
        ×{invocations}
      </span>
    </div>
  );
}

// ---- Main export ----

export function Metrics() {
  const [range, setRange] = useState<RangePeriod>("30d");
  const [groupBy, setGroupBy] = useState<GroupByMode>("project");

  const chartQ = useQuery({
    queryKey: ["metrics.daily.chart", range, groupBy],
    queryFn: () => {
      const { startIso, endIso } = computeRange(range);
      return trpc.metrics.daily.query({
        start: startIso,
        end: endIso,
        groupBy,
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
    const totalCost = s.buckets.reduce((sum, b) => sum + b.totalCostUsd, 0);
    const totalRuns = s.buckets.reduce((sum, b) => sum + b.runCount, 0);
    const avgCostPerRun = totalRuns > 0 ? totalCost / totalRuns : 0;
    return { totalCost, totalRuns, avgCostPerRun };
  }, [totalsQ.data]);

  const chartState = useMemo((): "loading" | "empty" | "degraded" | "normal" => {
    if (totalsQ.isLoading) return "loading";
    const s = totalsQ.data?.series?.[0];
    if (!s) return "empty";
    if (!s.buckets.some((b) => b.invocations > 0)) return "empty";
    if (!s.buckets.some((b) => b.totalCostUsd > 0)) return "degraded";
    return "normal";
  }, [totalsQ.isLoading, totalsQ.data]);

  const summaryData = summary.data;
  const sortedProjects = useMemo(
    () =>
      summaryData ? [...summaryData.byProject].sort((a, b) => b.totalCostUsd - a.totalCostUsd) : [],
    [summaryData],
  );
  const sortedKinds = useMemo(
    () =>
      summaryData
        ? [...summaryData.byOwnerKind].sort((a, b) => b.totalCostUsd - a.totalCostUsd)
        : [],
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
          Cost and token usage across every Claude invocation Heimdall has made.
        </p>
      </header>

      {/* Range spend section */}
      <section>
        <SectionHeader
          title="spend"
          right={
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                {(["7d", "30d", "90d"] as const).map((p) => (
                  <PillButton key={p} label={p} active={range === p} onClick={() => setRange(p)} />
                ))}
              </div>
              <div className="w-px h-3 bg-[var(--color-line)]" />
              <div className="flex gap-1">
                {(["project", "model"] as const).map((g) => (
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
          <div className="surface p-4 grid grid-cols-3 gap-3">
            <HeadlineStat
              label="range total"
              value={headlines ? fmtCost(headlines.totalCost) : "$0"}
            />
            <HeadlineStat
              label="avg / run"
              value={headlines?.totalRuns ? fmtCost(headlines.avgCostPerRun) : "—"}
            />
            <HeadlineStat label="runs" value={headlines ? String(headlines.totalRuns) : "0"} />
          </div>
        )}

        {/* Chart area */}
        <div className="surface mt-2 p-3 overflow-hidden">
          {chartState === "loading" ? (
            <div className="skel rounded" style={{ height: SVG_H }} />
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
                cost data unavailable
              </div>
              <p className="mono text-[10.5px] text-[var(--color-fg-3)] text-center max-w-[260px]">
                {headlines?.totalRuns ?? 0} runs recorded in the {rangeLabel} but no cost figures
                were captured · rows may pre-date cost tracking
              </p>
            </div>
          ) : chartQ.data ? (
            <>
              <SpendChart days={chartQ.data.days} series={chartQ.data.series} />
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
    </div>
  );
}

// Re-export for convenience so other components can render compact metric chips.
export { chipLabel };
