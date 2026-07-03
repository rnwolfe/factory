import { type Db, METRICS_PORTFOLIO, schema } from "@factory/db";
import {
  DERIVED_RATIO_WINDOW,
  METRIC_CATALOG,
  type MetricContext,
  type MetricDef,
  type MetricProject,
  type MetricWindow,
  windowBounds,
} from "./catalog.ts";
import { dayKey, floorToUtcDay } from "./rollup.ts";

/**
 * Live metric snapshot (fixes the "empty today bucket just after UTC midnight"
 * class of bug). Instead of reading the most-recent row out of `metrics_daily`
 * — which lags behind reality until the rollup tick refreshes today — the
 * snapshot evaluates {@link METRIC_CATALOG} at request time.
 *
 * Each metric is computed over its **own declared window** ({@link MetricWindow}):
 * headline COUNT tiles (runs, decisions, commits) are `cumulative` — the running
 * all-time total — while the derived RATE ratios (decisions-per-run, auto-ratify
 * rate) use a trailing window ({@link DERIVED_RATIO_WINDOW}) so they read as a
 * "lately" signal, not a life-of-project average. `windows`/`derivedWindow` echo
 * back which window each number covers so the PWA can label the tile ("all-time"
 * vs "7d") — no tile's window is left implicit.
 *
 * `scope` is either {@link METRICS_PORTFOLIO} (portfolio total) or a project id.
 */

export interface LiveSnapshot {
  date: string | null;
  metrics: Record<string, number>;
  /** The window each metric in `metrics` was computed over — drives tile labels. */
  windows: Record<string, MetricWindow>;
  derived: {
    decisions_per_run: number;
    auto_ratify_rate: number;
  };
  /** The window the derived rate ratios were computed over. */
  derivedWindow: MetricWindow;
}

function loadProjects(db: Db): MetricProject[] {
  return db
    .select({
      id: schema.projects.id,
      slug: schema.projects.slug,
      workdirPath: schema.projects.workdirPath,
      autonomyMode: schema.projects.autonomyMode,
    })
    .from(schema.projects)
    .all()
    .map((p) => ({ ...p, autonomyMode: p.autonomyMode ?? "collaborative" }));
}

/** Does a metric's scope admit this snapshot's scope? Mirrors the rollup. */
function metricApplies(def: MetricDef, target: MetricProject | null): boolean {
  return target === null ? def.scope !== "project" : def.scope !== "portfolio";
}

export async function computeLiveSnapshot(
  db: Db,
  scope: string,
  now: number,
): Promise<LiveSnapshot> {
  const projects = loadProjects(db);
  const isPortfolio = scope === METRICS_PORTFOLIO;
  const target = isPortfolio ? null : (projects.find((p) => p.id === scope) ?? null);

  // Evaluate a catalog def over an explicit window at this snapshot's scope.
  const evalOver = (
    def: MetricDef,
    window: MetricWindow,
  ): Promise<number | null> | number | null => {
    const { startMs, endMs } = windowBounds(window, now);
    const ctx: MetricContext = {
      db,
      dayStartMs: startMs,
      dayEndMs: endMs,
      project: target,
      projects,
    };
    return def.compute(ctx);
  };

  const metrics: Record<string, number> = {};
  const windows: Record<string, MetricWindow> = {};
  // A project scope that names no known project yields an empty snapshot rather
  // than silently falling back to the portfolio total.
  if (isPortfolio || target) {
    for (const def of METRIC_CATALOG) {
      if (!metricApplies(def, target)) continue;
      const value = await evalOver(def, def.window);
      if (value == null) continue;
      metrics[def.key] = value;
      windows[def.key] = def.window;
    }
  }

  // Rate ratios are a "lately" signal — recompute their inputs over the rolling
  // ratio window, independent of the cumulative COUNT tiles above (you can't read
  // a rolling rate off an all-time total).
  const ratioInput = async (key: string): Promise<number> => {
    const def = METRIC_CATALOG.find((d) => d.key === key);
    if (!def || (!isPortfolio && !target) || !metricApplies(def, target)) return 0;
    return (await evalOver(def, DERIVED_RATIO_WINDOW)) ?? 0;
  };
  const runs = await ratioInput("runs_total");
  const decisions = await ratioInput("decisions_total");
  const ratified = await ratioInput("auto_ratified_total");

  return {
    date: dayKey(floorToUtcDay(now)),
    metrics,
    windows,
    derived: {
      decisions_per_run: runs ? decisions / runs : 0,
      auto_ratify_rate: decisions ? ratified / decisions : 0,
    },
    derivedWindow: DERIVED_RATIO_WINDOW,
  };
}

/**
 * The live value of a single metric for **today's UTC day bucket**
 * (`[floorToUtcDay(now), now)`), at a scope — the current-day point the
 * `metrics.series` chart appends onto its finalized daily rollup buckets.
 *
 * This is deliberately NOT the windowed snapshot: the daily time-series needs a
 * per-day value (so the last point lines up with the rollup's day buckets),
 * whereas the headline tiles want cumulative/rolling windows. Returns `null`
 * when the metric is unknown, doesn't apply to the scope, or computes null —
 * the same "write no row" contract the rollup honors.
 */
export async function computeMetricDayBucket(
  db: Db,
  metricKey: string,
  scope: string,
  now: number,
): Promise<number | null> {
  const def = METRIC_CATALOG.find((d) => d.key === metricKey);
  if (!def) return null;
  const projects = loadProjects(db);
  const isPortfolio = scope === METRICS_PORTFOLIO;
  const target = isPortfolio ? null : (projects.find((p) => p.id === scope) ?? null);
  if (!isPortfolio && !target) return null;
  if (!metricApplies(def, target)) return null;
  const dayStartMs = floorToUtcDay(now);
  return def.compute({ db, dayStartMs, dayEndMs: now, project: target, projects });
}
