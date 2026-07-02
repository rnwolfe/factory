import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { type ImportCandidate, listImportableIssues } from "./github-task-store.ts";

/** Decision payload for a bulk reap of untracked upstream issues. */
export interface IssueImportPayload {
  candidates: ImportCandidate[];
}

export interface RaiseImportResult {
  candidates: number;
  decisionId: string | null;
}

/**
 * Reap pre-existing upstream issues (ADR-007 companion to the file → issues
 * migration). Enumerates OPEN issues Factory doesn't already track and, if any
 * exist, raises ONE pending `issue_import` decision listing them — the operator
 * picks which to adopt (multi-select), preserving the inbox-as-only-attention-
 * sink + "external issues never silently become tasks" (D4) contracts.
 *
 * Operator-triggered only (the "Import existing issues" action); never fired at
 * migration. Idempotent: refreshes the existing pending decision's candidate
 * list rather than stacking duplicates, so re-running just re-reads upstream.
 * Returns `{ candidates: 0, decisionId: null }` when there's nothing to import.
 */
export async function raiseIssueImportDecision(
  deps: { db: Db; config: FactoryConfig; events: EventBus },
  projectId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<RaiseImportResult> {
  const { db, config, events } = deps;
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) throw new Error(`project not found: ${projectId}`);
  if (project.taskBackend !== "github-issues") {
    throw new Error("import is only available on projects using the GitHub Issues backend");
  }

  const candidates = await listImportableIssues(config, project, fetchFn);
  const payload: IssueImportPayload = { candidates };

  const existing = await db
    .select()
    .from(schema.decisions)
    .where(
      and(
        eq(schema.decisions.projectId, projectId),
        eq(schema.decisions.kind, "issue_import"),
        eq(schema.decisions.status, "pending"),
      ),
    )
    .get();

  // Nothing untracked upstream: clear any stale pending decision so the inbox
  // doesn't advertise imports that no longer exist, then report empty.
  if (candidates.length === 0) {
    if (existing) {
      await db
        .update(schema.decisions)
        .set({ status: "dismissed", actionedAt: Date.now() })
        .where(eq(schema.decisions.id, existing.id));
      events.publish({
        channel: "inbox",
        kind: "decision_actioned",
        decisionId: existing.id,
        projectId,
      });
    }
    return { candidates: 0, decisionId: null };
  }

  if (existing) {
    await db.update(schema.decisions).set({ payload }).where(eq(schema.decisions.id, existing.id));
    events.publish({
      channel: "inbox",
      kind: "decision_updated",
      decisionId: existing.id,
      projectId,
    });
    return { candidates: candidates.length, decisionId: existing.id };
  }

  const decisionId = createId();
  await db.insert(schema.decisions).values({
    id: decisionId,
    kind: "issue_import",
    projectId,
    outcome: "import",
    payload,
    status: "pending",
    createdAt: Date.now(),
  });
  events.publish({ channel: "inbox", kind: "decision_created", decisionId, projectId });
  return { candidates: candidates.length, decisionId };
}
