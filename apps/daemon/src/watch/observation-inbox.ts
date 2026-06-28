import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import type { EventBus } from "../events.ts";
import type { PersistedObservation } from "./observation-store.ts";
import type { ObservationEvidence } from "./synthesize.ts";

/**
 * Surface newly-persisted observations into the decisions inbox as
 * `watch_insight` decisions (ADR-010 §3/§5). Notify-grade, never blocking; the
 * operator adopts (→ task), acknowledges, or dismisses from the inbox. The
 * observation row's status flips `pending → surfaced` so it isn't re-surfaced.
 */

/** The `decisions.payload` shape for a `watch_insight` decision. */
export interface WatchInsightPayload {
  observationId: string;
  observationKind: PersistedObservation["kind"];
  title: string;
  detail: string;
  proposal: PersistedObservation["proposal"];
  evidence: ObservationEvidence[];
  /** Slug the insight maps to, or null for an operator-level (cross-project) one. */
  targetProjectSlug: string | null;
  /** The specific task to act on (groom-backlog promotion), or null. */
  targetTaskId?: string | null;
}

export function surfaceObservations(
  db: Db,
  events: EventBus,
  observations: PersistedObservation[],
): void {
  const now = Date.now();
  for (const o of observations) {
    // Resolve slug → projectId; operator-level insights have neither.
    let projectId: string | null = null;
    if (o.targetProjectSlug) {
      const project = db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.slug, o.targetProjectSlug))
        .get();
      projectId = project?.id ?? null;
    }

    const decisionId = createId();
    const payload: WatchInsightPayload = {
      observationId: o.id,
      observationKind: o.kind,
      title: o.title,
      detail: o.detail,
      proposal: o.proposal,
      evidence: o.evidence,
      targetProjectSlug: o.targetProjectSlug,
      targetTaskId: o.targetTaskId ?? null,
    };
    db.insert(schema.decisions)
      .values({
        id: decisionId,
        kind: "watch_insight",
        projectId,
        outcome: "watch_insight",
        payload,
        status: "pending",
        createdAt: now,
      })
      .run();
    db.update(schema.watchObservations)
      .set({ status: "surfaced", updatedAt: now })
      .where(eq(schema.watchObservations.id, o.id))
      .run();
    events.publish({
      channel: "inbox",
      kind: "decision_created",
      decisionId,
      projectId: projectId ?? undefined,
    });
  }
}
