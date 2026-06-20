import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq } from "drizzle-orm";

/**
 * Intervention log — the first-class record of operator interventions on a run
 * (task-049). Today the richest signal in Factory, the
 * `blocked run → operator reply → re-run` loop, lives scattered across
 * `runs.blocker_questions`, `decision_comments`, and `runs.operator_context`,
 * invisible to any audit. This records that loop as a queryable `dialog`
 * intervention alongside the existing `worktree_repair` interventions.
 *
 * Interface-first: callers depend on `InterventionLog`, not on the table, so a
 * future backend (remote store, append-only event log, etc.) is a one-class
 * swap — mirrors the `TaskStore` seam in `projects/tasks.ts`. `interventionLog`
 * is the single construction point.
 */

export interface DialogInterventionInput {
  decisionId: string;
  projectId: string;
  /** The blocked run the operator is replying to. */
  sourceRunId: string;
  /** Mirrored from the source run so the NOT NULL columns hold (a dialog has
   * no session of its own). */
  worktreePath: string;
  tmuxSessionName: string;
  /** The agent's blocker questions, verbatim. */
  blockerQuestions: string[];
  /** The operator's reply that drove the re-run. */
  operatorReply: string;
  /** The run the reply spawned. */
  retryRunId: string;
}

export interface InterventionRecord {
  id: string;
  type: "worktree_repair" | "dialog";
  decisionId: string;
  decisionKind: string;
  projectId: string;
  sourceRunId: string | null;
  blockerQuestions: string[] | null;
  operatorReply: string | null;
  retryRunId: string | null;
  status: string;
  outcome: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface InterventionLog {
  /** Record a blocker→reply→re-run dialog as a first-class intervention. */
  recordDialog(input: DialogInterventionInput): Promise<string>;
  /** Close the open dialog intervention whose retry produced `retryRunId`,
   * stamping the retry's terminal status as the outcome. No-op when none
   * references this run (so it's safe to call after every run). */
  closeDialogForRetry(retryRunId: string, outcome: string): Promise<void>;
  listForRun(runId: string): Promise<InterventionRecord[]>;
  listForDecision(decisionId: string): Promise<InterventionRecord[]>;
}

type Row = typeof schema.interventions.$inferSelect;

function toRecord(r: Row): InterventionRecord {
  return {
    id: r.id,
    type: r.type,
    decisionId: r.decisionId,
    decisionKind: r.decisionKind,
    projectId: r.projectId,
    sourceRunId: r.sourceRunId,
    blockerQuestions: r.blockerQuestions ?? null,
    operatorReply: r.operatorReply ?? null,
    retryRunId: r.retryRunId ?? null,
    status: r.status,
    outcome: r.outcome ?? null,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
  };
}

export class DbInterventionLog implements InterventionLog {
  constructor(private readonly db: Db) {}

  async recordDialog(input: DialogInterventionInput): Promise<string> {
    const id = createId();
    await this.db.insert(schema.interventions).values({
      id,
      decisionId: input.decisionId,
      decisionKind: "blocked_run",
      type: "dialog",
      projectId: input.projectId,
      sourceRunId: input.sourceRunId,
      worktreePath: input.worktreePath,
      tmuxSessionName: input.tmuxSessionName,
      blockerQuestions: input.blockerQuestions,
      operatorReply: input.operatorReply,
      retryRunId: input.retryRunId,
      status: "active",
      startedAt: Date.now(),
    });
    return id;
  }

  async closeDialogForRetry(retryRunId: string, outcome: string): Promise<void> {
    const open = await this.db
      .select()
      .from(schema.interventions)
      .where(
        and(
          eq(schema.interventions.type, "dialog"),
          eq(schema.interventions.retryRunId, retryRunId),
          eq(schema.interventions.status, "active"),
        ),
      )
      .all();
    for (const row of open) {
      await this.db
        .update(schema.interventions)
        .set({ status: "resolved", outcome, endedAt: Date.now() })
        .where(eq(schema.interventions.id, row.id));
    }
  }

  async listForRun(runId: string): Promise<InterventionRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.interventions)
      .where(eq(schema.interventions.sourceRunId, runId))
      .orderBy(desc(schema.interventions.startedAt))
      .all();
    return rows.map(toRecord);
  }

  async listForDecision(decisionId: string): Promise<InterventionRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.interventions)
      .where(eq(schema.interventions.decisionId, decisionId))
      .orderBy(desc(schema.interventions.startedAt))
      .all();
    return rows.map(toRecord);
  }
}

/** Single construction point — swap the impl here to change the backend. */
export function interventionLog(db: Db): InterventionLog {
  return new DbInterventionLog(db);
}
