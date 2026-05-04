import { type ClaudeMetricsOwnerKind, schema } from "@factory/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
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
});
