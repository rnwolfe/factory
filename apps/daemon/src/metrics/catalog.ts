import { type Db, schema } from "@factory/db";
import { and, count, eq, gte, isNotNull, lt } from "drizzle-orm";
import { gitDayStats } from "./git-stats.ts";

/**
 * The metric catalog (ADR-013) — the single source of truth for what the ops
 * surface tracks. Each metric is a self-contained {@link MetricDef}: adding one
 * is a single entry here, never a schema or UI change. The rollup, the API, and
 * the PWA all iterate this catalog; nothing branches on a metric key.
 *
 * `compute` returns a value for one (day-window, scope) — `ctx.project === null`
 * means the portfolio total. Return `null` to write no row.
 */

export interface MetricProject {
  id: string;
  slug: string;
  workdirPath: string;
  autonomyMode: "collaborative" | "autonomous";
}

export interface MetricContext {
  db: Db;
  /** [dayStartMs, dayEndMs) — a single UTC day. */
  dayStartMs: number;
  dayEndMs: number;
  /** The project, or null for the portfolio total. */
  project: MetricProject | null;
  /** All projects (for portfolio snapshots + git summation). */
  projects: MetricProject[];
}

export type MetricScope = "project" | "portfolio" | "both";

/**
 * The time window a metric's *live snapshot* value covers (the headline tiles).
 * Made explicit so no tile's number is ambiguous — a bare "12 runs" means
 * nothing without saying "all-time" vs "last 7 days".
 *
 * - `cumulative` — everything up to now (`[epoch, now)`). Headline COUNT tiles
 *   (runs, decisions, commits): a running total the operator watches climb.
 * - `rolling_24h` / `rolling_7d` — a trailing window ending now. RATE signals
 *   (decisions-per-run, auto-ratify rate) that would be meaningless as an
 *   all-time average — you want "how are we trending lately", not the mean over
 *   the project's whole life.
 *
 * NB: this governs the **live snapshot** only. The daily rollup (`rollupDay`)
 * always evaluates a single UTC-day bucket for the time-series charts, and the
 * `metrics.series` current-day point is likewise a day bucket — neither reads
 * `window`. See {@link windowBounds} and `metrics/snapshot.ts`.
 */
export type MetricWindow = "cumulative" | "rolling_24h" | "rolling_7d";

const DAY_MS = 86_400_000;

/** Resolve a {@link MetricWindow} to a `[startMs, endMs)` range ending at `now`. */
export function windowBounds(
  window: MetricWindow,
  now: number,
): { startMs: number; endMs: number } {
  switch (window) {
    case "rolling_24h":
      return { startMs: now - DAY_MS, endMs: now };
    case "rolling_7d":
      return { startMs: now - 7 * DAY_MS, endMs: now };
    default:
      return { startMs: 0, endMs: now }; // cumulative — since the epoch
  }
}

export interface MetricDef {
  key: string;
  scope: MetricScope;
  /** Window the live snapshot computes this metric over (see {@link MetricWindow}). */
  window: MetricWindow;
  compute(ctx: MetricContext): Promise<number | null> | number | null;
}

/**
 * The window the derived rate ratios (`decisions_per_run`, `auto_ratify_rate`)
 * are computed over in the live snapshot. Rates are a "lately" signal, so they
 * use a trailing window rather than an all-time average. The count metrics that
 * feed them still tile as `cumulative` — the snapshot recomputes their inputs
 * over this window independently. See `metrics/snapshot.ts`.
 */
export const DERIVED_RATIO_WINDOW: MetricWindow = "rolling_7d";

// ── shared compute helpers ───────────────────────────────────────────────────

/** Count runs STARTED in the window, optionally filtered to a project + status. */
function countRuns(ctx: MetricContext, status?: string): number {
  const conds = [
    gte(schema.runs.startedAt, ctx.dayStartMs),
    lt(schema.runs.startedAt, ctx.dayEndMs),
  ];
  if (ctx.project) conds.push(eq(schema.runs.projectId, ctx.project.id));
  if (status) conds.push(eq(schema.runs.status, status as "completed"));
  return (
    ctx.db
      .select({ c: count() })
      .from(schema.runs)
      .where(and(...conds))
      .get()?.c ?? 0
  );
}

/** Count decisions CREATED in the window, optionally filtered to a project + kind/status. */
function countDecisions(ctx: MetricContext, opts: { kind?: string; status?: string } = {}): number {
  const conds = [
    gte(schema.decisions.createdAt, ctx.dayStartMs),
    lt(schema.decisions.createdAt, ctx.dayEndMs),
  ];
  if (ctx.project) conds.push(eq(schema.decisions.projectId, ctx.project.id));
  if (opts.kind) conds.push(eq(schema.decisions.kind, opts.kind as "agent_decision"));
  if (opts.status) conds.push(eq(schema.decisions.status, opts.status as "auto_ratified"));
  return (
    ctx.db
      .select({ c: count() })
      .from(schema.decisions)
      .where(and(...conds))
      .get()?.c ?? 0
  );
}

/** Count autonomy events of a kind in the window, optionally filtered to a project. */
function countAutonomyEvents(ctx: MetricContext, kind: string): number {
  const conds = [
    gte(schema.autonomyEvents.createdAt, ctx.dayStartMs),
    lt(schema.autonomyEvents.createdAt, ctx.dayEndMs),
    eq(schema.autonomyEvents.kind, kind),
  ];
  if (ctx.project) conds.push(eq(schema.autonomyEvents.projectId, ctx.project.id));
  return (
    ctx.db
      .select({ c: count() })
      .from(schema.autonomyEvents)
      .where(and(...conds))
      .get()?.c ?? 0
  );
}

/** Sum a git stat over the scope (one project, or all for the portfolio). */
async function gitSum(
  ctx: MetricContext,
  pick: (s: { commits: number; locAdded: number; locRemoved: number }) => number,
): Promise<number | null> {
  const targets = ctx.project ? [ctx.project] : ctx.projects;
  let total = 0;
  let any = false;
  for (const p of targets) {
    const s = await gitDayStats(p.workdirPath, ctx.dayStartMs, ctx.dayEndMs);
    if (s) {
      total += pick(s);
      any = true;
    }
  }
  return any ? total : null; // null when no project is a readable git repo
}

// ── the catalog (seed set — representative of every metric type) ──────────────

export const METRIC_CATALOG: MetricDef[] = [
  // Throughput & outcomes (DB flow, project + portfolio). Headline COUNT tiles —
  // cumulative so the snapshot shows the running all-time total.
  { key: "runs_total", scope: "both", window: "cumulative", compute: (c) => countRuns(c) },
  {
    key: "runs_completed",
    scope: "both",
    window: "cumulative",
    compute: (c) => countRuns(c, "completed"),
  },
  {
    key: "runs_failed",
    scope: "both",
    window: "cumulative",
    compute: (c) => countRuns(c, "failed"),
  },

  // Autonomy effectiveness (DB flow). `decisions_per_run` is derived downstream
  // from `decisions_total ÷ runs_total` (store raw so weekly/monthly aggregate
  // correctly — you can't average daily ratios).
  {
    key: "decisions_total",
    scope: "both",
    window: "cumulative",
    compute: (c) => countDecisions(c),
  },
  {
    key: "auto_ratified_total",
    scope: "both",
    window: "cumulative",
    compute: (c) => countDecisions(c, { kind: "agent_decision", status: "auto_ratified" }),
  },

  // Shipped work (git flow). Counts what landed on the canonical branch.
  {
    key: "commits",
    scope: "both",
    window: "cumulative",
    compute: (c) => gitSum(c, (s) => s.commits),
  },
  {
    key: "loc_added",
    scope: "both",
    window: "cumulative",
    compute: (c) => gitSum(c, (s) => s.locAdded),
  },
  {
    key: "loc_removed",
    scope: "both",
    window: "cumulative",
    compute: (c) => gitSum(c, (s) => s.locRemoved),
  },

  // Portfolio snapshots (point-in-time as of the rollup). `active_projects` is
  // "has run recently" — a trailing window, not all-time (cumulative would count
  // every project that ever ran).
  {
    key: "active_projects",
    scope: "portfolio",
    window: "rolling_7d",
    compute: (c) => {
      // projects with ≥1 run started in the window
      const rows = c.db
        .selectDistinct({ p: schema.runs.projectId })
        .from(schema.runs)
        .where(and(gte(schema.runs.startedAt, c.dayStartMs), lt(schema.runs.startedAt, c.dayEndMs)))
        .all();
      return rows.length;
    },
  },
  {
    key: "projects_collaborative",
    scope: "portfolio",
    window: "cumulative", // current mode count — window-independent
    compute: (c) => c.projects.filter((p) => p.autonomyMode === "collaborative").length,
  },
  {
    key: "projects_autonomous",
    scope: "portfolio",
    window: "cumulative", // current mode count — window-independent
    compute: (c) => c.projects.filter((p) => p.autonomyMode === "autonomous").length,
  },

  // The Watch output (DB flow): observations synthesized per day — makes the
  // synthesis loop's productivity chartable over time.
  {
    key: "watch_observations_created",
    scope: "portfolio",
    window: "cumulative",
    compute: (c) =>
      c.db
        .select({ n: count() })
        .from(schema.watchObservations)
        .where(
          and(
            gte(schema.watchObservations.createdAt, c.dayStartMs),
            lt(schema.watchObservations.createdAt, c.dayEndMs),
          ),
        )
        .get()?.n ?? 0,
  },

  // Autonomy events (ADR-016) — the unattended-action rates, chartable over time.
  {
    key: "autonomy_contractions",
    scope: "both",
    window: "cumulative",
    compute: (c) => countAutonomyEvents(c, "trust_contracted"),
  },
  {
    key: "autonomy_promotions",
    scope: "both",
    window: "cumulative",
    compute: (c) => countAutonomyEvents(c, "trust_promoted"),
  },
  {
    key: "autonomy_gate_held",
    scope: "both",
    window: "cumulative",
    compute: (c) => countAutonomyEvents(c, "gate_held"),
  },
  {
    key: "autonomy_auto_merged",
    scope: "both",
    window: "cumulative",
    compute: (c) => countAutonomyEvents(c, "auto_merged"),
  },
  {
    key: "autonomy_auto_ran",
    scope: "both",
    window: "cumulative",
    compute: (c) => countAutonomyEvents(c, "auto_ran"),
  },

  // Auto-retry loop health (ADR-016 slice 4) — the meta-signal. A high
  // resolved:exhausted ratio means the gate catches *fixable* defects; lots of
  // `exhausted` means hard problems OR an over-zealous "model always finds
  // something" gate. `auto_retries ÷ runs that entered the loop` ≈ avg retries.
  {
    key: "auto_retries",
    scope: "both",
    window: "cumulative",
    compute: (c) => countAutonomyEvents(c, "auto_retried"),
  },
  {
    key: "auto_retry_exhausted",
    scope: "both",
    window: "cumulative",
    compute: (c) => countAutonomyEvents(c, "auto_retry_exhausted"),
  },
  {
    // Retries that SELF-HEALED: a run that was itself a retry and then completed.
    key: "auto_retry_resolved",
    scope: "both",
    window: "cumulative",
    compute: (c) => {
      const conds = [
        gte(schema.runs.startedAt, c.dayStartMs),
        lt(schema.runs.startedAt, c.dayEndMs),
        isNotNull(schema.runs.retryOfRunId),
        eq(schema.runs.status, "completed"),
      ];
      if (c.project) conds.push(eq(schema.runs.projectId, c.project.id));
      return (
        c.db
          .select({ n: count() })
          .from(schema.runs)
          .where(and(...conds))
          .get()?.n ?? 0
      );
    },
  },
];
