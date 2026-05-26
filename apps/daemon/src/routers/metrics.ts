import { type ClaudeMetricsOwnerKind, schema } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

const OwnerKindEnum = z.enum([
  "run",
  "audit",
  "audit_exec",
  "plan_iteration",
  "triage",
  "audit_promote",
  "audit_comment",
]);

interface AggregateRow {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  invocations: number;
}

const ZERO: AggregateRow = {
  totalCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  durationMs: 0,
  invocations: 0,
};

function aggregateExpressions() {
  return {
    totalCostUsd: sql<number>`COALESCE(SUM(${schema.claudeMetrics.totalCostUsd}), 0)`,
    inputTokens: sql<number>`COALESCE(SUM(${schema.claudeMetrics.inputTokens}), 0)`,
    outputTokens: sql<number>`COALESCE(SUM(${schema.claudeMetrics.outputTokens}), 0)`,
    cacheCreationTokens: sql<number>`COALESCE(SUM(${schema.claudeMetrics.cacheCreationTokens}), 0)`,
    cacheReadTokens: sql<number>`COALESCE(SUM(${schema.claudeMetrics.cacheReadTokens}), 0)`,
    durationMs: sql<number>`COALESCE(SUM(${schema.claudeMetrics.durationMs}), 0)`,
    invocations: sql<number>`COUNT(*)`,
  };
}

const DAY_MS = 86_400_000;

function utcDayIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Inclusive list of UTC days touched by [startMs, endMs). The first bucket
 * is the UTC day containing startMs; the last is the UTC day before endMs.
 * Used to zero-fill the response so charts render contiguous timelines.
 */
function enumerateUtcDays(startMs: number, endMs: number): string[] {
  const firstDay = Math.floor(startMs / DAY_MS) * DAY_MS;
  const days: string[] = [];
  for (let t = firstDay; t < endMs; t += DAY_MS) {
    days.push(utcDayIso(t));
  }
  return days;
}

interface DailyBucket {
  day: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  invocations: number;
  runCount: number;
}

function zeroBucket(day: string): DailyBucket {
  return {
    day,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
    invocations: 0,
    runCount: 0,
  };
}

export const metricsRouter = router({
  /**
   * Top-level totals across every persisted invocation, with per-project and
   * per-owner-kind roll-ups. Used by the dashboard tile and the global
   * /metrics route.
   */
  summary: protectedProcedure
    .input(
      z
        .object({
          /** Restrict to invocations newer than this timestamp (ms since epoch). */
          since: z.number().int().nonnegative().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const sinceFilter = input?.since ? gte(schema.claudeMetrics.createdAt, input.since) : null;
      const where = sinceFilter ?? undefined;

      const totalsRow = await ctx.db
        .select(aggregateExpressions())
        .from(schema.claudeMetrics)
        .where(where)
        .get();
      const totals = totalsRow ?? ZERO;

      const byProject = await ctx.db
        .select({
          projectId: schema.claudeMetrics.projectId,
          ...aggregateExpressions(),
        })
        .from(schema.claudeMetrics)
        .where(where)
        .groupBy(schema.claudeMetrics.projectId)
        .all();

      const byOwnerKind = await ctx.db
        .select({
          ownerKind: schema.claudeMetrics.ownerKind,
          ...aggregateExpressions(),
        })
        .from(schema.claudeMetrics)
        .where(where)
        .groupBy(schema.claudeMetrics.ownerKind)
        .all();

      return { totals, byProject, byOwnerKind };
    }),

  /**
   * Per-project totals + recent invocations. Used on the project header chip
   * and the project metrics drawer.
   */
  forProject: protectedProcedure
    .input(
      z.object({ projectId: z.string(), recentLimit: z.number().int().min(1).max(50).optional() }),
    )
    .query(async ({ ctx, input }) => {
      const totalsRow = await ctx.db
        .select(aggregateExpressions())
        .from(schema.claudeMetrics)
        .where(eq(schema.claudeMetrics.projectId, input.projectId))
        .get();
      const totals = totalsRow ?? ZERO;

      const byOwnerKind = await ctx.db
        .select({
          ownerKind: schema.claudeMetrics.ownerKind,
          ...aggregateExpressions(),
        })
        .from(schema.claudeMetrics)
        .where(eq(schema.claudeMetrics.projectId, input.projectId))
        .groupBy(schema.claudeMetrics.ownerKind)
        .all();

      const recent = await ctx.db
        .select()
        .from(schema.claudeMetrics)
        .where(eq(schema.claudeMetrics.projectId, input.projectId))
        .orderBy(desc(schema.claudeMetrics.createdAt))
        .limit(input.recentLimit ?? 20)
        .all();

      return { totals, byOwnerKind, recent };
    }),

  /**
   * Aggregated metrics for a single Factory entity (run, audit, plan, etc.).
   * Plan iterations sum across all turns; runs are typically a single row.
   * Returns null totals when no rows exist (entity hasn't been measured yet
   * or pre-dates the metrics rollout).
   */
  forOwner: protectedProcedure
    .input(z.object({ ownerKind: OwnerKindEnum, ownerId: z.string() }))
    .query(async ({ ctx, input }) => {
      const totalsRow = await ctx.db
        .select(aggregateExpressions())
        .from(schema.claudeMetrics)
        .where(
          and(
            eq(schema.claudeMetrics.ownerKind, input.ownerKind as ClaudeMetricsOwnerKind),
            eq(schema.claudeMetrics.ownerId, input.ownerId),
          ),
        )
        .get();
      return { totals: totalsRow ?? ZERO };
    }),

  /**
   * Sum metrics across every owner kind that references a single audit id —
   * the read-only/exec iteration plus the promote bridge and follow-up
   * comments. Audits accrue cost across all four kinds, and the operator's
   * mental model is "this audit cost X" not "this audit's iteration cost X."
   */
  forAudit: protectedProcedure
    .input(z.object({ auditId: z.string() }))
    .query(async ({ ctx, input }) => {
      const totalsRow = await ctx.db
        .select(aggregateExpressions())
        .from(schema.claudeMetrics)
        .where(
          and(
            eq(schema.claudeMetrics.ownerId, input.auditId),
            sql`${schema.claudeMetrics.ownerKind} IN ('audit','audit_exec','audit_promote','audit_comment')`,
          ),
        )
        .get();
      return { totals: totalsRow ?? ZERO };
    }),

  /**
   * Bulk lookup so a list of cards can render their cost chips with a single
   * query. Returns a map from ownerId to AggregateRow. Cards that aren't in
   * the map have no recorded metrics yet — render no chip.
   */
  forOwners: protectedProcedure
    .input(
      z.object({
        ownerKind: OwnerKindEnum,
        ownerIds: z.array(z.string()).min(1).max(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          ownerId: schema.claudeMetrics.ownerId,
          ...aggregateExpressions(),
        })
        .from(schema.claudeMetrics)
        .where(
          and(
            eq(schema.claudeMetrics.ownerKind, input.ownerKind as ClaudeMetricsOwnerKind),
            sql`${schema.claudeMetrics.ownerId} IN ${input.ownerIds}`,
          ),
        )
        .groupBy(schema.claudeMetrics.ownerId)
        .all();
      const map: Record<string, AggregateRow> = {};
      for (const r of rows) {
        const { ownerId, ...rest } = r;
        map[ownerId] = rest;
      }
      return map;
    }),

  /**
   * Daily totals across `claude_metrics` for charting. Each bucket is a UTC
   * calendar day (YYYY-MM-DD) of cost / tokens / invocations / distinct runs;
   * the response is zero-filled across [start, end) so the timeline is
   * contiguous even on days with no recorded activity.
   *
   * - `start` / `end` are ISO timestamps. The half-open interval matches the
   *   range scan against `claude_metrics_created_idx` (or, when projectId is
   *   set, the composite `claude_metrics_project_created_idx`).
   * - `projectId` restricts to one project. `groupBy` partitions by:
   *   - `project` → `project_id`
   *   - `model`   → primary model captured on each row (null ids preserved)
   *   - `agent`   → canonical agent id (`claude-code` | `codex` | …); rows
   *                 written before migration 0027 may carry `null` agent
   *   - `agent+model` → composite key `"<agent>||<model>"` so series can
   *                     distinguish "claude opus" from "claude sonnet" while
   *                     still keeping both under the claude umbrella
   *   - `none`    → unpartitioned
   * - `runCount` is COUNT DISTINCT owner_id where owner_kind='run' — i.e.
   *   the number of distinct runs that recorded at least one invocation in
   *   the bucket. Other owner kinds (audits, plan iterations, triage) flow
   *   into the cost/token sums but not into runCount.
   */
  daily: protectedProcedure
    .input(
      z.object({
        start: z.string().datetime(),
        end: z.string().datetime(),
        projectId: z.string().optional(),
        groupBy: z.enum(["project", "model", "agent", "agent+model", "none"]).default("none"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const startMs = new Date(input.start).getTime();
      const endMs = new Date(input.end).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "invalid ISO timestamp" });
      }
      if (endMs <= startMs) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "end must be after start" });
      }

      const days = enumerateUtcDays(startMs, endMs);

      const daySql = sql<string>`strftime('%Y-%m-%d', ${schema.claudeMetrics.createdAt} / 1000, 'unixepoch')`;
      const runCountSql = sql<number>`COUNT(DISTINCT CASE WHEN ${schema.claudeMetrics.ownerKind} = 'run' THEN ${schema.claudeMetrics.ownerId} END)`;

      const conds = [
        gte(schema.claudeMetrics.createdAt, startMs),
        lt(schema.claudeMetrics.createdAt, endMs),
      ];
      if (input.projectId) {
        conds.push(eq(schema.claudeMetrics.projectId, input.projectId));
      }
      const where = and(...conds);

      const baseSelect = {
        day: daySql.as("day"),
        ...aggregateExpressions(),
        runCount: runCountSql,
      };

      type GroupedRow = AggregateRow & {
        day: string;
        runCount: number;
        seriesKey: string | null;
      };

      let rows: GroupedRow[];
      if (input.groupBy === "project") {
        const r = await ctx.db
          .select({ ...baseSelect, seriesKey: schema.claudeMetrics.projectId })
          .from(schema.claudeMetrics)
          .where(where)
          .groupBy(daySql, schema.claudeMetrics.projectId)
          .all();
        rows = r as GroupedRow[];
      } else if (input.groupBy === "model") {
        const r = await ctx.db
          .select({ ...baseSelect, seriesKey: schema.claudeMetrics.model })
          .from(schema.claudeMetrics)
          .where(where)
          .groupBy(daySql, schema.claudeMetrics.model)
          .all();
        rows = r as GroupedRow[];
      } else if (input.groupBy === "agent") {
        const r = await ctx.db
          .select({ ...baseSelect, seriesKey: schema.claudeMetrics.agent })
          .from(schema.claudeMetrics)
          .where(where)
          .groupBy(daySql, schema.claudeMetrics.agent)
          .all();
        rows = r as GroupedRow[];
      } else if (input.groupBy === "agent+model") {
        // Composite key. `||` is SQLite's string-concat operator; ifnull
        // keeps null-agent / null-model rows from collapsing the whole bucket
        // to NULL (which would lose the distinction between "unknown agent"
        // and "unknown model").
        const compositeSql = sql<string>`IFNULL(${schema.claudeMetrics.agent}, '') || '||' || IFNULL(${schema.claudeMetrics.model}, '')`;
        const r = await ctx.db
          .select({ ...baseSelect, seriesKey: compositeSql })
          .from(schema.claudeMetrics)
          .where(where)
          .groupBy(daySql, compositeSql)
          .all();
        rows = r as GroupedRow[];
      } else {
        const r = await ctx.db
          .select(baseSelect)
          .from(schema.claudeMetrics)
          .where(where)
          .groupBy(daySql)
          .all();
        rows = r.map((row) => ({ ...row, seriesKey: null }));
      }

      const grouped = new Map<string | null, Map<string, GroupedRow>>();
      for (const row of rows) {
        let inner = grouped.get(row.seriesKey);
        if (!inner) {
          inner = new Map();
          grouped.set(row.seriesKey, inner);
        }
        inner.set(row.day, row);
      }

      const seriesKeys: Array<string | null> =
        input.groupBy === "none"
          ? [null]
          : Array.from(grouped.keys()).sort((a, b) => {
              if (a === null) return b === null ? 0 : 1;
              if (b === null) return -1;
              return a.localeCompare(b);
            });

      const series = seriesKeys.map((key) => {
        const inner = grouped.get(key);
        const buckets: DailyBucket[] = days.map((day) => {
          const row = inner?.get(day);
          if (!row) return zeroBucket(day);
          return {
            day,
            totalCostUsd: Number(row.totalCostUsd ?? 0),
            inputTokens: Number(row.inputTokens ?? 0),
            outputTokens: Number(row.outputTokens ?? 0),
            cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
            cacheReadTokens: Number(row.cacheReadTokens ?? 0),
            durationMs: Number(row.durationMs ?? 0),
            invocations: Number(row.invocations ?? 0),
            runCount: Number(row.runCount ?? 0),
          };
        });
        return { key, buckets };
      });

      return {
        start: input.start,
        end: input.end,
        groupBy: input.groupBy,
        days,
        series,
      };
    }),

  /**
   * Total agent-work runtime — the operator-facing "Factory has produced X
   * hours of agent work" number — broken down by project and agent.
   *
   * Two parallel counters per slice:
   *
   * - **wallClockMs**: `SUM(runs.ended_at - runs.started_at)` over completed
   *   runs. Wall-clock per run from spawn to teardown, including tool calls,
   *   git operations, merge attempts, the works. Each run counts once. This
   *   is the headline figure ("agent worked for X hours").
   *
   * - **apiMs**: `SUM(claude_metrics.duration_ms)` over the same window.
   *   API+turn time as reported by each provider's result envelope. A
   *   strict subset of wall-clock (smaller because it misses idle gaps,
   *   tool-only stretches, and post-turn daemon work). Useful for "how
   *   much of the runtime was actually generating tokens?"
   *
   * Filters: `projectId` restricts to one project; the global call (no
   * filter) is the dashboard headline. Ended-but-not-completed runs
   * (failed, aborted, blocked) are excluded — operator-visible "agent
   * work hours" is usually completed work; failures are still in
   * `claude_metrics` but don't get counted in the headline.
   */
  runtime: protectedProcedure
    .input(
      z
        .object({
          projectId: z.string().optional(),
          since: z.number().int().nonnegative().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const sinceFilter = input?.since ? gte(schema.runs.startedAt, input.since) : null;
      const projectFilter = input?.projectId ? eq(schema.runs.projectId, input.projectId) : null;
      const baseRunWhere = and(
        ...[
          sql`${schema.runs.endedAt} IS NOT NULL`,
          sinceFilter ?? undefined,
          projectFilter ?? undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      );

      const wallClockExpr = sql<number>`COALESCE(SUM(${schema.runs.endedAt} - ${schema.runs.startedAt}), 0)`;
      const runCountExpr = sql<number>`COUNT(*)`;

      const totalsRow = await ctx.db
        .select({
          wallClockMs: wallClockExpr,
          runCount: runCountExpr,
        })
        .from(schema.runs)
        .where(baseRunWhere)
        .get();

      // API time is the sum of durationMs in claude_metrics over the same
      // filter set. Joining metrics→runs lets us scope by project + start
      // window through the runs row even when the metric row's createdAt is
      // slightly off the run's startedAt.
      const apiSinceFilter = input?.since ? gte(schema.claudeMetrics.createdAt, input.since) : null;
      const apiProjectFilter = input?.projectId
        ? eq(schema.claudeMetrics.projectId, input.projectId)
        : null;
      const apiWhere = and(
        ...[apiSinceFilter ?? undefined, apiProjectFilter ?? undefined].filter(
          (c): c is NonNullable<typeof c> => c !== undefined,
        ),
      );
      const apiRow = await ctx.db
        .select({
          apiMs: sql<number>`COALESCE(SUM(${schema.claudeMetrics.durationMs}), 0)`,
        })
        .from(schema.claudeMetrics)
        .where(apiWhere)
        .get();

      // Per-project breakdown for the runtime dashboard.
      const byProject = await ctx.db
        .select({
          projectId: schema.runs.projectId,
          wallClockMs: wallClockExpr,
          runCount: runCountExpr,
        })
        .from(schema.runs)
        .where(baseRunWhere)
        .groupBy(schema.runs.projectId)
        .all();

      // Per-agent breakdown for the runtime dashboard. Rows recorded before
      // migration 0027 have null agent; they collapse into a single
      // "(unattributed)" bucket the PWA can render as such.
      const byAgent = await ctx.db
        .select({
          agent: schema.runs.agentName,
          wallClockMs: wallClockExpr,
          runCount: runCountExpr,
        })
        .from(schema.runs)
        .where(baseRunWhere)
        .groupBy(schema.runs.agentName)
        .all();

      return {
        totals: {
          wallClockMs: Number(totalsRow?.wallClockMs ?? 0),
          apiMs: Number(apiRow?.apiMs ?? 0),
          runCount: Number(totalsRow?.runCount ?? 0),
        },
        byProject: byProject.map((r) => ({
          projectId: r.projectId,
          wallClockMs: Number(r.wallClockMs),
          runCount: Number(r.runCount),
        })),
        byAgent: byAgent.map((r) => ({
          agent: r.agent,
          wallClockMs: Number(r.wallClockMs),
          runCount: Number(r.runCount),
        })),
      };
    }),
});
