import { type Db, schema } from "@factory/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { type AutonomyConfig, resolveAutonomyConfig } from "../autonomy/config.ts";
import { cleanStreak } from "../workers/trust-ladder.ts";

/**
 * Read-only derivations powering the Heimdall surface's "how far you've let it
 * go" (trust ladder) and "what the system did on its own" (merge/auto counts)
 * signals. Pure where possible; the DB-touching helpers reuse the canonical
 * `cleanStreak` (workers/trust-ladder.ts) and `resolveAutonomyConfig` so there's
 * no second source of truth.
 */

export type TrustRung = "supervised" | "collaborative" | "autonomous";

export interface TrustState {
  rung: TrustRung;
  /** Consecutive clean (completed + verifier-`high`) runs, leading edge. */
  cleanStreak: number;
  /** Clean-run target to ratchet collaborative → autonomous. */
  promoteStreak: number;
}

export interface MergeStats {
  /** Runs started since local midnight (any status). */
  runsToday: number;
  /** Completed (≈ merged — completed runs auto-merge) runs since local midnight. */
  mergedToday: number;
  /** Of those, how many merged unattended (`auto_merged` autonomy events today). */
  autoMergedToday: number;
  /** Merged ÷ decisive outcomes (completed+failed+aborted), 0..100, or null when none. */
  mergedPct: number | null;
}

/**
 * Map the 2-value `autonomyMode` onto the design's 3-rung ladder. `autonomous`
 * is the top rung; a `collaborative` project sits at `collaborative` while its
 * ladder can still move itself, and drops to the implicit `supervised` floor
 * when auto-promotion is disabled (the ladder is frozen — it will never ratchet
 * up on its own).
 */
export function deriveTrustRung(
  autonomyMode: "collaborative" | "autonomous",
  cfg: AutonomyConfig,
): TrustRung {
  if (autonomyMode === "autonomous") return "autonomous";
  return cfg.trust.autoPromote ? "collaborative" : "supervised";
}

/** Trust ladder state for one project (rung + streak progress toward the next). */
export function projectTrustState(
  db: Db,
  project: { id: string; autonomyMode: "collaborative" | "autonomous" },
): TrustState {
  const cfg = resolveAutonomyConfig(db, project.id);
  const promoteStreak = cfg.trust.promoteStreak;
  return {
    rung: deriveTrustRung(project.autonomyMode, cfg),
    cleanStreak: cleanStreak(db, project.id, promoteStreak + 5),
    promoteStreak,
  };
}

function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's merge activity + lifetime merged-rate for one project. */
export function projectMergeStats(db: Db, projectId: string, now = Date.now()): MergeStats {
  const midnight = startOfLocalDay(now);

  const runAgg = db
    .select({
      runsToday: sql<number>`SUM(CASE WHEN ${schema.runs.startedAt} >= ${midnight} THEN 1 ELSE 0 END)`,
      mergedToday: sql<number>`SUM(CASE WHEN ${schema.runs.startedAt} >= ${midnight} AND ${schema.runs.status} = 'completed' THEN 1 ELSE 0 END)`,
      completed: sql<number>`SUM(CASE WHEN ${schema.runs.status} = 'completed' THEN 1 ELSE 0 END)`,
      decisive: sql<number>`SUM(CASE WHEN ${schema.runs.status} IN ('completed','failed','aborted') THEN 1 ELSE 0 END)`,
    })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .get();

  const autoMergedToday = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.autonomyEvents)
    .where(
      and(
        eq(schema.autonomyEvents.projectId, projectId),
        eq(schema.autonomyEvents.kind, "auto_merged"),
        gte(schema.autonomyEvents.createdAt, midnight),
      ),
    )
    .get();

  const decisive = Number(runAgg?.decisive ?? 0);
  const completed = Number(runAgg?.completed ?? 0);
  return {
    runsToday: Number(runAgg?.runsToday ?? 0),
    mergedToday: Number(runAgg?.mergedToday ?? 0),
    autoMergedToday: Number(autoMergedToday?.n ?? 0),
    mergedPct: decisive > 0 ? Math.round((completed / decisive) * 100) : null,
  };
}
