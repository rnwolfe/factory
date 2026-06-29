import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { EventBus } from "../events.ts";
import { type AutonomyEventKind, resolveAutonomyConfig } from "./config.ts";

/**
 * The single write seam for the autonomy event log (ADR-016). Every unattended
 * autonomy action calls this — it persists the event (→ /ops history + metrics)
 * AND emits a bus event carrying the *resolved* alert route, so the push
 * dispatcher just reads the route instead of re-resolving config.
 */
export interface AutonomyEventInput {
  kind: AutonomyEventKind;
  projectId: string | null;
  runId?: string | null;
  message: string;
  detail?: unknown;
}

export function recordAutonomyEvent(db: Db, events: EventBus, input: AutonomyEventInput): void {
  db.insert(schema.autonomyEvents)
    .values({
      id: createId(),
      projectId: input.projectId,
      runId: input.runId ?? null,
      kind: input.kind,
      message: input.message,
      detail: input.detail !== undefined ? JSON.stringify(input.detail) : null,
      createdAt: Date.now(),
    })
    .run();

  const alert = resolveAutonomyConfig(db, input.projectId).alerts[input.kind] ?? "off";
  events.publish({
    channel: "events",
    projectId: input.projectId,
    kind: "autonomy_event",
    autonomyKind: input.kind,
    runId: input.runId ?? null,
    message: input.message,
    alert,
  });
}
