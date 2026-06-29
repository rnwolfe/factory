import { type Db, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { EventBus } from "../events.ts";
import { updateTaskStatus } from "../projects/tasks.ts";
import type { PersistedObservation } from "../watch/observation-store.ts";
import { isAutoRunEligible } from "./auto-run.ts";
import { resolveAutonomyConfig } from "./config.ts";
import { recordAutonomyEvent } from "./events.ts";

/**
 * Phase C (ADR-017): auto-EXECUTE eligible Watch proposals instead of surfacing
 * them for operator approval — the human-out-of-the-loop step that completes the
 * autonomy thesis.
 *
 * The first (and intentionally smallest) auto-run class is `groom-backlog`: a
 * REVERSIBLE task-status flip (close a stale backlog task), which can't break a
 * build — the safest possible proving ground. It runs only behind the full
 * eligibility gate (autorun.enabled + top-rung + class allow-list + per-tick
 * budget + kill-switch), so this ships DARK: with the default config
 * (autorun.enabled=false, classes=[]) nothing is eligible and every proposal
 * surfaces exactly as before.
 *
 * Returns the set of observation ids that were auto-executed — the caller skips
 * surfacing those (they're already actioned). Every auto-execution records an
 * `auto_ran` event (→ push alert + /ops history), so the operator is told.
 */
export async function autoExecuteEligibleProposals(
  db: Db,
  events: EventBus,
  observations: PersistedObservation[],
): Promise<Set<string>> {
  const executed = new Set<string>();
  // Per-project auto-run count for THIS tick (this surface batch) — the loop bound.
  const ranThisTick = new Map<string, number>();

  for (const o of observations) {
    if (o.proposal !== "groom-backlog" || !o.targetProjectSlug || !o.targetTaskId) continue;

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.slug, o.targetProjectSlug))
      .get();
    if (!project) continue;

    const cfg = resolveAutonomyConfig(db, project.id);
    const already = ranThisTick.get(project.id) ?? 0;
    const verdict = isAutoRunEligible(
      {
        proposalClass: "groom-backlog",
        isCodeRun: false, // a status flip, not a code-changing run
        projectAutonomyMode: project.autonomyMode,
        hasQualityGate: false, // N/A for a non-code action
        runsThisTick: already,
      },
      cfg,
    );
    if (!verdict.eligible) continue;

    try {
      await updateTaskStatus(project, o.targetTaskId, "dropped");
    } catch (err) {
      // Execution failed (file/IO) — leave it to surface so the operator drives it.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[phase-c] auto-groom close failed for ${o.targetTaskId}: ${msg}`);
      continue;
    }

    ranThisTick.set(project.id, already + 1);
    db.update(schema.watchObservations)
      .set({ status: "adopted", updatedAt: Date.now() })
      .where(eq(schema.watchObservations.id, o.id))
      .run();
    recordAutonomyEvent(db, events, {
      kind: "auto_ran",
      projectId: project.id,
      message: `${project.name} auto-closed a stale backlog task — ${o.title}`,
      detail: { observationId: o.id, proposal: "groom-backlog", targetTaskId: o.targetTaskId },
    });
    executed.add(o.id);
  }

  return executed;
}
