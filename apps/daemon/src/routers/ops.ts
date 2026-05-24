import { type Db, schema } from "@factory/db";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";

import { snapshotSettings } from "../settings/store.ts";
import { protectedProcedure, router } from "../trpc.ts";

/**
 * Operational-awareness snapshot for the dashboard ticker and `/ops` page.
 *
 * Combines four queries that the home/ticker would otherwise have to make
 * separately and re-correlate on the client: live runs, recent terminal
 * activity, active intervene sessions, and rolling usage windows from
 * `claude_metrics`. Single endpoint so the client gets a consistent view
 * (no skew between "5 running" and "4 recent" because the queries
 * happened seconds apart).
 *
 * Per-meter usage % is computed when the operator has configured the
 * corresponding cap (settings: `usage-cap-{session,weekly}-tokens`,
 * `usage-cap-daily-usd`). Without a cap, we return null for that % — the
 * ticker shows the absolute number instead of pretending we know the
 * ceiling.
 */

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const RECENT_HORIZON_MS = 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 25;

function startOfTodayLocal(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
}

async function aggregateUsage(db: Db, sinceMs: number): Promise<UsageBucket> {
  const rows = await db
    .select({
      inputTokens: schema.claudeMetrics.inputTokens,
      outputTokens: schema.claudeMetrics.outputTokens,
      totalCostUsd: schema.claudeMetrics.totalCostUsd,
    })
    .from(schema.claudeMetrics)
    .where(gte(schema.claudeMetrics.createdAt, sinceMs))
    .all();
  const bucket: UsageBucket = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
  for (const r of rows) {
    bucket.inputTokens += r.inputTokens ?? 0;
    bucket.outputTokens += r.outputTokens ?? 0;
    bucket.totalCostUsd += r.totalCostUsd ?? 0;
  }
  return bucket;
}

function pctOfCap(used: number, cap: number | null): number | null {
  if (cap == null || cap <= 0) return null;
  return Math.min(100, (used / cap) * 100);
}

export const opsRouter = router({
  snapshot: protectedProcedure.query(async ({ ctx }) => {
    const now = Date.now();

    // 1. Live runs (running/queued).
    const liveRows = await ctx.db
      .select({
        id: schema.runs.id,
        status: schema.runs.status,
        taskId: schema.runs.taskId,
        startedAt: schema.runs.startedAt,
        iteration: schema.runs.iterationCount,
        projectId: schema.runs.projectId,
        projectSlug: schema.projects.slug,
        projectName: schema.projects.name,
      })
      .from(schema.runs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]))
      .orderBy(desc(schema.runs.startedAt))
      .all();

    const running = liveRows.filter((r) => r.status === "running");
    const queued = liveRows.filter((r) => r.status === "queued");

    // 2. Recent terminal activity in the last 24h.
    const recent = await ctx.db
      .select({
        id: schema.runs.id,
        status: schema.runs.status,
        taskId: schema.runs.taskId,
        endedAt: schema.runs.endedAt,
        projectId: schema.runs.projectId,
        projectSlug: schema.projects.slug,
      })
      .from(schema.runs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(
        and(
          gte(schema.runs.endedAt, now - RECENT_HORIZON_MS),
          ne(schema.runs.status, "queued"),
          ne(schema.runs.status, "running"),
        ),
      )
      .orderBy(desc(schema.runs.endedAt))
      .limit(RECENT_LIMIT)
      .all();

    // 3. Active intervene/shell sessions.
    const sessions = await ctx.db
      .select({
        id: schema.sessions.id,
        mode: schema.sessions.mode,
        startedAt: schema.sessions.startedAt,
        projectId: schema.sessions.projectId,
        projectSlug: schema.projects.slug,
      })
      .from(schema.sessions)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
      .where(eq(schema.sessions.status, "running"))
      .orderBy(desc(schema.sessions.startedAt))
      .all();

    // 4. Usage aggregation across rolling windows + today.
    const todayStart = startOfTodayLocal();
    const today = await aggregateUsage(ctx.db, todayStart);
    const rolling5h = await aggregateUsage(ctx.db, now - FIVE_HOURS_MS);
    const rolling7d = await aggregateUsage(ctx.db, now - SEVEN_DAYS_MS);

    // 5. Caps from operator settings → % per meter when a cap is set.
    const settings = snapshotSettings(ctx.db, ctx.config);
    const caps = settings.ops.caps;

    return {
      ts: now,
      running: running.map((r) => ({
        ...r,
        durationMs: now - r.startedAt,
      })),
      queued,
      recent,
      sessions,
      usage: {
        today: {
          ...today,
          pctOfDailyUsdCap: pctOfCap(today.totalCostUsd, caps.dailyUsd),
        },
        rolling5h: {
          ...rolling5h,
          pctOfSessionTokensCap: pctOfCap(
            rolling5h.inputTokens + rolling5h.outputTokens,
            caps.sessionTokens,
          ),
        },
        rolling7d: {
          ...rolling7d,
          pctOfWeeklyTokensCap: pctOfCap(
            rolling7d.inputTokens + rolling7d.outputTokens,
            caps.weeklyTokens,
          ),
        },
        caps,
      },
    };
  }),
});
