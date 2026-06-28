import { type Db, schema } from "@factory/db";
import { desc, eq } from "drizzle-orm";
import type { VerifierReport } from "./verifier.ts";

/**
 * The Trust Ladder's auto-movement (ADR-012 Slice 2). The per-project autonomy
 * level moves ITSELF on track record instead of being a manual switch:
 *
 * - **Contracts** (autonomous → collaborative) immediately on a run failure, a
 *   merge conflict, or an operator override of an auto-ratified fork — each is a
 *   precise signal that trust was misplaced. Safety always wins; automatic.
 * - **Ratchets up** (collaborative → autonomous) after N consecutive CLEAN runs:
 *   completed + verifier-`high` (WS C). The verifier gate is the clean signal.
 *
 * Today's binary `autonomyMode` is the 2-rung ladder (L1 collaborative / L2
 * on-the-loop). The merge boundary is unchanged — this moves *attention*: how
 * agent_decision forks are handled (pending vs auto-ratified). Promotion only ever
 * widens to verifier-gated auto-merge, never an ungated one.
 */

/** Consecutive clean runs that earn a step up. Tunable (ADR-012 open-q 2: N=5). */
export const PROMOTE_STREAK = 5;

interface TrustProject {
  id: string;
  name: string;
  autonomyMode: "collaborative" | "autonomous";
}

function verifierLevel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as VerifierReport).level;
  } catch {
    return null;
  }
}

/** A run counts toward the streak only if it completed AND verified `high`. */
function isCleanRun(r: { status: string; verifierReport: string | null }): boolean {
  return r.status === "completed" && verifierLevel(r.verifierReport) === "high";
}

/** Leading run of consecutive clean outcomes for a project (most-recent first). */
export function cleanStreak(db: Db, projectId: string): number {
  const rows = db
    .select({ status: schema.runs.status, verifierReport: schema.runs.verifierReport })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(desc(schema.runs.startedAt))
    .limit(PROMOTE_STREAK + 5)
    .all();
  let n = 0;
  for (const r of rows) {
    if (!isCleanRun(r)) break;
    n += 1;
  }
  return n;
}

function setMode(db: Db, projectId: string, mode: TrustProject["autonomyMode"]): void {
  db.update(schema.projects)
    .set({ autonomyMode: mode })
    .where(eq(schema.projects.id, projectId))
    .run();
}

/**
 * Drop autonomous → collaborative (the safety ratchet). No-op if already
 * collaborative. Returns true if it moved.
 */
export function autoContract(db: Db, project: TrustProject, reason: string): boolean {
  if (project.autonomyMode !== "autonomous") return false;
  setMode(db, project.id, "collaborative");
  console.warn(`[trust] ${project.name} auto-contracted autonomous → collaborative — ${reason}`);
  return true;
}

/**
 * Ratchet collaborative → autonomous once the project has a clean streak. No-op
 * otherwise. Returns true if it moved.
 */
export function maybeAutoPromote(db: Db, project: TrustProject): boolean {
  if (project.autonomyMode !== "collaborative") return false;
  if (cleanStreak(db, project.id) < PROMOTE_STREAK) return false;
  setMode(db, project.id, "autonomous");
  console.log(`[trust] ${project.name} earned autonomous after ${PROMOTE_STREAK} clean runs`);
  return true;
}

/**
 * Evaluate the ladder at run finalize. A held (`needs_review`) run is the gate
 * working, not a failure — it neither contracts nor promotes.
 */
export function evaluateTrustOnOutcome(
  db: Db,
  project: TrustProject,
  outcome: { finalStatus: string; mergeConflict: boolean },
): void {
  if (outcome.finalStatus === "failed" || outcome.mergeConflict) {
    autoContract(db, project, outcome.mergeConflict ? "merge conflict" : "run failed");
    return;
  }
  if (outcome.finalStatus === "completed") {
    maybeAutoPromote(db, project);
  }
}
