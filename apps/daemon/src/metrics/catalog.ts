import { type Db, schema } from "@factory/db";
import { and, count, eq, gte, lt } from "drizzle-orm";
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

export interface MetricDef {
  key: string;
  scope: MetricScope;
  compute(ctx: MetricContext): Promise<number | null> | number | null;
}

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
  // Throughput & outcomes (DB flow, project + portfolio).
  { key: "runs_total", scope: "both", compute: (c) => countRuns(c) },
  { key: "runs_completed", scope: "both", compute: (c) => countRuns(c, "completed") },
  { key: "runs_failed", scope: "both", compute: (c) => countRuns(c, "failed") },

  // Autonomy effectiveness (DB flow). `decisions_per_run` is derived downstream
  // from `decisions_total ÷ runs_total` (store raw so weekly/monthly aggregate
  // correctly — you can't average daily ratios).
  { key: "decisions_total", scope: "both", compute: (c) => countDecisions(c) },
  {
    key: "auto_ratified_total",
    scope: "both",
    compute: (c) => countDecisions(c, { kind: "agent_decision", status: "auto_ratified" }),
  },

  // Shipped work (git flow). Counts what landed on the canonical branch.
  { key: "commits", scope: "both", compute: (c) => gitSum(c, (s) => s.commits) },
  { key: "loc_added", scope: "both", compute: (c) => gitSum(c, (s) => s.locAdded) },
  { key: "loc_removed", scope: "both", compute: (c) => gitSum(c, (s) => s.locRemoved) },

  // Portfolio snapshots (point-in-time as of the rollup).
  {
    key: "active_projects",
    scope: "portfolio",
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
    compute: (c) => c.projects.filter((p) => p.autonomyMode === "collaborative").length,
  },
  {
    key: "projects_autonomous",
    scope: "portfolio",
    compute: (c) => c.projects.filter((p) => p.autonomyMode === "autonomous").length,
  },

  // The Watch output (DB flow): observations synthesized per day — makes the
  // synthesis loop's productivity chartable over time.
  {
    key: "watch_observations_created",
    scope: "portfolio",
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
    compute: (c) => countAutonomyEvents(c, "trust_contracted"),
  },
  {
    key: "autonomy_promotions",
    scope: "both",
    compute: (c) => countAutonomyEvents(c, "trust_promoted"),
  },
  { key: "autonomy_gate_held", scope: "both", compute: (c) => countAutonomyEvents(c, "gate_held") },
  {
    key: "autonomy_auto_merged",
    scope: "both",
    compute: (c) => countAutonomyEvents(c, "auto_merged"),
  },
  { key: "autonomy_auto_ran", scope: "both", compute: (c) => countAutonomyEvents(c, "auto_ran") },
];
