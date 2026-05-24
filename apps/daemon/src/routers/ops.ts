import { type Db, schema } from "@factory/db";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";

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
const RECENT_LIMIT = 25;

/**
 * Calendar-aligned window starts in the host's local time. We track usage
 * against billing periods (Anthropic resets the Agent SDK credit monthly),
 * not rolling burn rates — that's better-matched to "have I blown my
 * monthly budget" framing than rolling 24h / 7d / 30d windows.
 */
function startOfTodayLocal(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeekLocal(): number {
  // Monday as the week start (ISO convention; matches how most operators
  // think about "this week"). Sunday-as-start can be added later as a
  // setting if anyone disagrees.
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - daysSinceMonday);
  return d.getTime();
}

function startOfMonthLocal(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
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

    // 4. Usage aggregation across calendar-aligned windows. Today resets at
    // local midnight, week at local Monday 00:00, month at local 1st 00:00.
    // The month window in particular matches Anthropic's Agent SDK credit
    // reset cycle (post-2026-06-15) — useful for "have I blown my monthly
    // budget" framing.
    const today = await aggregateUsage(ctx.db, startOfTodayLocal());
    const thisWeek = await aggregateUsage(ctx.db, startOfWeekLocal());
    const thisMonth = await aggregateUsage(ctx.db, startOfMonthLocal());

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
        today,
        thisWeek,
        thisMonth,
      },
    };
  }),
});
