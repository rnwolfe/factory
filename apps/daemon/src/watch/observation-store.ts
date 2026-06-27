import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { RawObservation } from "./synthesize.ts";

/**
 * Persist synthesized observations, deduped (ADR-010 §3). The `dedupeKey` is the
 * idempotency handle: an observation already in the table (pending, surfaced, or
 * dismissed) is never re-inserted, so re-scanning the same window — which
 * happens whenever a synthesis run fails before committing its cursors — can't
 * spawn duplicate inbox items.
 */

/** Stable key from kind + target + normalized title. */
export function dedupeKey(o: RawObservation): string {
  const subject = o.title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  return `${o.kind}:${o.targetProjectSlug ?? "_"}:${subject}`;
}

export function saveObservations(
  db: Db,
  observations: RawObservation[],
): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;
  const now = Date.now();
  for (const o of observations) {
    const key = dedupeKey(o);
    const existing = db
      .select({ id: schema.watchObservations.id })
      .from(schema.watchObservations)
      .where(eq(schema.watchObservations.dedupeKey, key))
      .get();
    if (existing) {
      skipped++;
      continue;
    }
    db.insert(schema.watchObservations)
      .values({
        id: createId(),
        kind: o.kind,
        title: o.title,
        detail: o.detail,
        evidence: JSON.stringify(o.evidence),
        proposal: o.proposal,
        targetProjectSlug: o.targetProjectSlug,
        status: "pending",
        dedupeKey: key,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    inserted++;
  }
  return { inserted, skipped };
}
