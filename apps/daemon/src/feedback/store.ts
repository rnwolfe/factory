import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type InboxView, snoozeWhere } from "../inbox-snooze.ts";

export interface AppendInput {
  vote: "up" | "down";
  body: string;
  contextRoute?: string | null;
  contextHint?: string | null;
}

export function appendFeedback(db: Db, input: AppendInput) {
  const id = createId();
  db.insert(schema.feedback)
    .values({
      id,
      vote: input.vote,
      body: input.body,
      contextRoute: input.contextRoute ?? null,
      contextHint: input.contextHint ?? null,
      status: "open",
      createdAt: Date.now(),
    })
    .run();
  return getFeedback(db, id);
}

export function getFeedback(db: Db, id: string) {
  return db.select().from(schema.feedback).where(eq(schema.feedback.id, id)).get() ?? null;
}

export function listOpenFeedback(db: Db, view: InboxView = "active") {
  const now = Date.now();
  return db
    .select()
    .from(schema.feedback)
    .where(
      and(
        inArray(schema.feedback.status, ["open", "in_progress"]),
        snoozeWhere(schema.feedback.snoozedUntil, view, now),
      ),
    )
    .orderBy(desc(schema.feedback.createdAt))
    .all();
}

export function setFeedbackStatus(
  db: Db,
  id: string,
  status: "open" | "in_progress" | "resolved" | "dismissed",
  opts?: { resolvedTarget?: string | null },
) {
  db.update(schema.feedback)
    .set({
      status,
      resolvedAt: status === "resolved" ? Date.now() : null,
      resolvedTarget: opts?.resolvedTarget ?? null,
    })
    .where(eq(schema.feedback.id, id))
    .run();
  return getFeedback(db, id);
}

export function setFeedbackSession(db: Db, id: string, sessionId: string) {
  db.update(schema.feedback)
    .set({ claudeSessionId: sessionId })
    .where(and(eq(schema.feedback.id, id)))
    .run();
}
