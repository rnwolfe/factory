import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import type { EventBus } from "../events.ts";
import { readAllSettings } from "../settings/store.ts";

/**
 * Queue-empty nudge (task-050). When auto-advance drains a project's ready
 * queue, the project stalls silently — nothing surfaces that it's out of
 * runway (fathom sat dormant ~5 weeks this way). This emits a single
 * `queue_empty` inbox decision so the operator can re-fill or archive.
 *
 * Gated behind the `notify-on-queue-empty` setting (default off) so it never
 * adds inbox noise for projects the operator is deliberately parking. The
 * single attention sink stays quiet unless opted in.
 */

interface ProjectLike {
  id: string;
  slug: string;
  name: string;
}

async function pendingNudgeIds(db: Db, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.decisions.id })
    .from(schema.decisions)
    .where(
      and(
        eq(schema.decisions.kind, "queue_empty"),
        eq(schema.decisions.projectId, projectId),
        eq(schema.decisions.status, "pending"),
      ),
    )
    .all();
  return rows.map((r) => r.id);
}

/**
 * Emit a queue-empty nudge for a project whose ready queue just drained.
 * No-op when the flag is off or an unresolved nudge already exists for the
 * project (de-dupe — at most one open nudge per project at a time).
 */
export async function maybeEmitQueueEmptyNudge(
  db: Db,
  events: EventBus,
  project: ProjectLike,
): Promise<void> {
  if (readAllSettings(db).get("notify-on-queue-empty") !== "true") return;
  if ((await pendingNudgeIds(db, project.id)).length > 0) return;

  const decisionId = createId();
  await db.insert(schema.decisions).values({
    id: decisionId,
    kind: "queue_empty",
    projectId: project.id,
    outcome: "queue_empty",
    payload: { projectSlug: project.slug, projectName: project.name },
    status: "pending",
    createdAt: Date.now(),
  });
  events.publish({
    channel: "inbox",
    kind: "decision_created",
    decisionId,
    projectId: project.id,
  });
}

/**
 * Resolve any open queue-empty nudge for a project — call when ready tasks
 * reappear (a new run is submitted) or the project is archived, so a stale
 * "out of runway" card doesn't linger after the condition clears.
 */
export async function resolveQueueEmptyNudges(
  db: Db,
  events: EventBus,
  projectId: string,
): Promise<void> {
  const ids = await pendingNudgeIds(db, projectId);
  for (const id of ids) {
    await db
      .update(schema.decisions)
      .set({ status: "actioned", actionedAt: Date.now() })
      .where(eq(schema.decisions.id, id));
    events.publish({ channel: "inbox", kind: "decision_updated", decisionId: id, projectId });
  }
}
