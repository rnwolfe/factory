import { type Db, METRICS_PORTFOLIO, schema } from "@factory/db";
import { METRIC_CATALOG, type MetricProject } from "./catalog.ts";
import { dayKey, floorToUtcDay } from "./rollup.ts";

/**
 * Live metric snapshot (fixes the "empty today bucket just after UTC midnight"
 * class of bug). Instead of reading the most-recent row out of `metrics_daily`
 * — which lags behind reality until the rollup tick refreshes today — the
 * snapshot evaluates {@link METRIC_CATALOG} against a window ending at request
 * time. The window is "today so far" in UTC: `[floorToUtcDay(now), now)`. Same
 * math the rollup runs, but computed on demand, so a run/decision recorded a
 * second ago is already reflected without any rollup having run.
 *
 * `scope` is either {@link METRICS_PORTFOLIO} (portfolio total) or a project id.
 */

export interface LiveSnapshot {
  date: string | null;
  metrics: Record<string, number>;
  derived: {
    decisions_per_run: number;
    auto_ratify_rate: number;
  };
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

export async function computeLiveSnapshot(
  db: Db,
  scope: string,
  now: number,
): Promise<LiveSnapshot> {
  const dayStartMs = floorToUtcDay(now);
  const dayEndMs = now; // window ends at request time — "today so far"
  const projects = loadProjects(db);
  const isPortfolio = scope === METRICS_PORTFOLIO;
  const target = isPortfolio ? null : (projects.find((p) => p.id === scope) ?? null);

  const metrics: Record<string, number> = {};
  // A project scope that names no known project yields an empty snapshot rather
  // than silently falling back to the portfolio total.
  if (isPortfolio || target) {
    for (const def of METRIC_CATALOG) {
      const applies = target === null ? def.scope !== "project" : def.scope !== "portfolio";
      if (!applies) continue;
      const value = await def.compute({ db, dayStartMs, dayEndMs, project: target, projects });
      if (value == null) continue;
      metrics[def.key] = value;
    }
  }

  const runs = metrics.runs_total ?? 0;
  const decisions = metrics.decisions_total ?? 0;
  return {
    date: dayKey(dayStartMs),
    metrics,
    // Derived north-star + Trust-Ladder health, computed from the live counts
    // above — never from a rolled-up day bucket.
    derived: {
      decisions_per_run: runs ? decisions / runs : 0,
      auto_ratify_rate: decisions ? (metrics.auto_ratified_total ?? 0) / decisions : 0,
    },
  };
}
