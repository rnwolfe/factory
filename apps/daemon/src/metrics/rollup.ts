import { type Db, METRICS_PORTFOLIO, schema } from "@factory/db";
import type { ScheduledJob } from "../workers/scheduler.ts";
import { METRIC_CATALOG, type MetricProject } from "./catalog.ts";

/**
 * Metric rollup (ADR-013). For a UTC day it iterates the catalog × scopes
 * (portfolio + each project), computes each value, and upserts it into
 * `metrics_daily`. Idempotent (upsert on `(date, projectId, metric)`), so a
 * partial "today" can be refreshed and a backfill can be re-run freely.
 */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a UTC instant. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Floor an instant to its UTC midnight (epoch is UTC-midnight aligned). */
export function floorToUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
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

function upsertMetric(
  db: Db,
  date: string,
  projectId: string,
  metric: string,
  value: number,
  now: number,
): void {
  db.insert(schema.metricsDaily)
    .values({ date, projectId, metric, value, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.metricsDaily.date, schema.metricsDaily.projectId, schema.metricsDaily.metric],
      set: { value, updatedAt: now },
    })
    .run();
}

export async function rollupDay(db: Db, instantInDay: number): Promise<{ rows: number }> {
  const dayStartMs = floorToUtcDay(instantInDay);
  const dayEndMs = dayStartMs + DAY_MS;
  const date = dayKey(dayStartMs);
  const projects = loadProjects(db);
  const now = Date.now();
  let rows = 0;

  // null = portfolio total, then one pass per project.
  const targets: Array<MetricProject | null> = [null, ...projects];
  for (const target of targets) {
    for (const def of METRIC_CATALOG) {
      const applies = target === null ? def.scope !== "project" : def.scope !== "portfolio";
      if (!applies) continue;
      const value = await def.compute({ db, dayStartMs, dayEndMs, project: target, projects });
      if (value == null) continue;
      upsertMetric(db, date, target?.id ?? METRICS_PORTFOLIO, def.key, value, now);
      rows++;
    }
  }
  return { rows };
}

/** Roll up every UTC day in `[fromMs, toMs)`. Idempotent; bounded by the caller. */
export async function backfillMetrics(
  db: Db,
  fromMs: number,
  toMs: number,
): Promise<{ days: number }> {
  let days = 0;
  for (let d = floorToUtcDay(fromMs); d < toMs; d += DAY_MS) {
    await rollupDay(db, d);
    days++;
  }
  return { days };
}

/**
 * Daily rollup job for the Watch scheduler (ADR-013). Fixed `daily` cadence —
 * cheap and not token-bound, so it does NOT share the synthesis cadence knob.
 * Each tick finalizes yesterday and refreshes today-so-far.
 */
export function createMetricsRollupJob(db: Db): ScheduledJob {
  return {
    id: "metrics-rollup",
    cadence: () => "daily",
    async run() {
      const today = floorToUtcDay(Date.now());
      await rollupDay(db, today - DAY_MS); // finalize the completed day
      await rollupDay(db, today); // refresh today-so-far
      console.log(`[metrics] rolled up ${dayKey(today - DAY_MS)} + ${dayKey(today)}`);
    },
  };
}
