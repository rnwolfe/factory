import { type Db, schema } from "@factory/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { RawObservation } from "../synthesize.ts";

/** Most-recent terminal runs that, if all failed, flag a project. */
const CONSECUTIVE_FAILURES = 3;

/**
 * In-band detector (ADR-011 §2): a project whose most recent terminal runs all
 * failed is likely hitting a systemic blocker. Emit a candidate-task to
 * investigate — rather than letting more runs burn on the same wall. The dedup
 * pass + the observation dedupe-key keep this idempotent across cadences, and it
 * stops firing once the operator adopts the task (it's then in the backlog).
 */
export function detectRunFailureSignals(db: Db): RawObservation[] {
  const projects = db
    .select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
    .from(schema.projects)
    .all();

  const out: RawObservation[] = [];
  for (const p of projects) {
    const recent = db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, p.id),
          inArray(schema.runs.status, ["completed", "failed", "aborted"]),
        ),
      )
      .orderBy(desc(schema.runs.startedAt))
      .limit(CONSECUTIVE_FAILURES)
      .all();
    if (recent.length < CONSECUTIVE_FAILURES) continue;
    if (recent.every((r) => r.status === "failed")) {
      out.push({
        kind: "candidate-task",
        title: `Investigate repeated run failures on ${p.slug}`,
        detail: `${p.name}'s last ${CONSECUTIVE_FAILURES} runs all failed — that points at a systemic blocker. Investigate and fix the root cause before more runs burn on the same wall.`,
        evidence: [], // in-band signal: no harness session backs it
        proposal: "adopt-as-task",
        targetProjectSlug: p.slug,
      });
    }
  }
  return out;
}
