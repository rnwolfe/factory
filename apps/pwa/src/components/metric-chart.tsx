/**
 * MetricChart — the single themeable Recharts wrapper for the ops/autonomy
 * surface (ADR-013 §4). Every historical chart on the read-only ops surface
 * goes through here so the dispatcher's-console palette is applied in exactly
 * one place: colors come from the CSS vars (`var(--color-accent)` etc.) handed
 * to Recharts via `stroke`/`fill`, the grid is a faint hairline, axes are
 * minimal mono, and the tooltip is a dark `surface-2` card. Swap a color or
 * tweak the grid here and every chart follows.
 *
 * A `ComposedChart` underneath lets one chart mix filled areas, plain lines, and
 * solid bars (e.g. a ratio line over a count area, or a diverging stacked-bar
 * token chart) without a second component. Diverging bars come for free: feed
 * one half of a stacked pair negated values and `stackOffset="sign"` splits the
 * stack across the zero baseline (input up, output down). Phone-first:
 * `ResponsiveContainer` fills its parent, so charts shrink to a 390px column;
 * `bare` strips the axes/grid/tooltip down to an inline sparkline.
 */

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartRow } from "../lib/metric-series.ts";

export interface ChartSeries {
  /** Row key to plot. */
  key: string;
  /** Human label (legend + tooltip). */
  label: string;
  /** Any CSS color — pass a palette var, e.g. `var(--color-accent)`. */
  color: string;
  /** `area` (default) draws a gradient fill; `line` is a bare stroke; `bar` a solid column. */
  kind?: "area" | "line" | "bar";
  /** Stack with sibling series of the same kind (autonomy mix; diverging tokens). */
  stacked?: boolean;
  /** Override the bar fill opacity (e.g. dim the output half of a diverging pair). */
  fillOpacity?: number;
}

interface MetricChartProps {
  data: ChartRow[];
  series: ChartSeries[];
  height?: number;
  /** Format an x-axis date tick / tooltip header. Defaults to identity. */
  formatX?: (date: string) => string;
  /** Format a y-axis tick. Defaults to a compact integer. */
  formatY?: (value: number) => string;
  /** Format a tooltip value. Defaults to `formatY`. */
  formatValue?: (value: number) => string;
  /** Render the empty placeholder instead of a chart. */
  empty?: boolean;
  emptyLabel?: string;
  /** Strip axes / grid / tooltip down to an inline sparkline. */
  bare?: boolean;
}

const GRID = "var(--color-line)";
const AXIS_TICK = {
  fill: "var(--color-fg-3)",
  fontSize: 9,
  fontFamily: "var(--font-mono)",
} as const;

function defaultFormatY(v: number): string {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Minimal shape we read off Recharts' tooltip payload — version-agnostic. */
interface TooltipInner {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    dataKey?: string | number;
    name?: string | number;
    value?: number | string;
    color?: string;
  }>;
}

function ChartTooltip({
  active,
  payload,
  label,
  formatX,
  formatValue,
}: TooltipInner & {
  formatX: (d: string) => string;
  formatValue: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="surface-2 px-2.5 py-1.5 shadow-lg">
      <div className="mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--color-fg-3)] mb-1">
        {formatX(String(label))}
      </div>
      <div className="flex flex-col gap-0.5">
        {payload.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: p.color }}
            />
            <span className="mono text-[10px] text-[var(--color-fg-2)]">{p.name}</span>
            <span className="mono text-[10px] text-[var(--color-fg)] tabular-nums ml-auto pl-3">
              {formatValue(Number(p.value ?? 0))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MetricChart({
  data,
  series,
  height = 160,
  formatX = (d) => d,
  formatY = defaultFormatY,
  formatValue,
  empty,
  emptyLabel = "no data in this range yet",
  bare = false,
}: MetricChartProps) {
  if (empty || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded border border-dashed border-[var(--color-line)]"
        style={{ height }}
      >
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{emptyLabel}</span>
      </div>
    );
  }
  const tooltipValue = formatValue ?? formatY;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={data}
        stackOffset="sign"
        margin={
          bare ? { top: 1, right: 0, bottom: 0, left: 0 } : { top: 6, right: 6, bottom: 0, left: 0 }
        }
      >
        <defs>
          {series
            .filter((s) => (s.kind ?? "area") === "area")
            .map((s) => (
              <linearGradient key={s.key} id={`mc-grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
        </defs>
        {!bare ? (
          <CartesianGrid stroke={GRID} strokeDasharray="2 3" vertical={false} strokeOpacity={0.6} />
        ) : null}
        <XAxis
          dataKey="date"
          hide={bare}
          tickFormatter={formatX}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          minTickGap={26}
          interval="preserveStartEnd"
        />
        <YAxis
          hide={bare}
          tickFormatter={formatY}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={32}
          allowDecimals={false}
        />
        {!bare ? (
          <Tooltip
            cursor={{ stroke: "var(--color-line-bright)", strokeWidth: 1 }}
            content={(props) => (
              <ChartTooltip
                {...(props as unknown as TooltipInner)}
                formatX={formatX}
                formatValue={tooltipValue}
              />
            )}
          />
        ) : null}
        {series.map((s) => {
          if (s.kind === "line") {
            return (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={1.75}
                dot={false}
                activeDot={{ r: 2.5, fill: s.color }}
                isAnimationActive={false}
              />
            );
          }
          if (s.kind === "bar") {
            return (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                fillOpacity={s.fillOpacity ?? 0.85}
                stackId={s.stacked ? "stack" : undefined}
                isAnimationActive={false}
              />
            );
          }
          return (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={1.5}
              fill={`url(#mc-grad-${s.key})`}
              stackId={s.stacked ? "stack" : undefined}
              dot={false}
              activeDot={{ r: 2.5, fill: s.color }}
              isAnimationActive={false}
            />
          );
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
