import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { recordClaudeMetrics } from "../metrics/record.ts";
import { invokeClaudeJson } from "../plans/invoke-claude.ts";

/**
 * Operator/agent thread on a completed audit. v0.4 cut 5 — replaces the
 * v0.3 "append a `## Discussion` section to reportMarkdown" approach with
 * a proper comment table. The audit's `reportMarkdown` now stops accruing
 * follow-ups; the report is the report, the thread is the thread.
 *
 * Existing audits whose reportMarkdown carries inline `## Discussion`
 * sections from v0.3 keep those inline — we don't migrate. The thread
 * starts fresh from the next operator comment.
 *
 * Surfaced in the audit pane as a chronological list immediately under
 * the report. Same visual shape as decision/plan threads.
 */

export interface AuditCommentRow {
  id: string;
  auditId: string;
  role: "operator" | "agent";
  body: string;
  createdAt: number;
}

export async function listAuditComments(db: Db, auditId: string): Promise<AuditCommentRow[]> {
  return db
    .select()
    .from(schema.auditComments)
    .where(eq(schema.auditComments.auditId, auditId))
    .orderBy(asc(schema.auditComments.createdAt))
    .all();
}

export async function appendOperatorComment(
  db: Db,
  auditId: string,
  body: string,
): Promise<AuditCommentRow> {
  const id = createId();
  const createdAt = Date.now();
  await db.insert(schema.auditComments).values({
    id,
    auditId,
    role: "operator",
    body,
    createdAt,
  });
  return { id, auditId, role: "operator", body, createdAt };
}

export interface AgentReplyResult {
  comment: AuditCommentRow | null;
  /** When non-null, the audit row's claudeSessionId was advanced to this id. */
  newSessionId: string | null;
  /** Surface in the agent's place if invoke failed. */
  errorMessage: string | null;
}

/**
 * Run the agent's reply turn for the most recent operator comment. Resumes
 * the audit's captured Claude session. Best-effort: if the session is gone
 * or the call fails, persists an `agent`-role row carrying the error so the
 * operator isn't left waiting on silence.
 */
export async function runAgentReply(
  db: Db,
  auditId: string,
  operatorBody: string,
): Promise<AgentReplyResult> {
  const audit = await db.select().from(schema.audits).where(eq(schema.audits.id, auditId)).get();
  if (!audit) {
    return { comment: null, newSessionId: null, errorMessage: "audit not found" };
  }

  // Older audits (v0.3 and earlier) may have no captured session. Persist a
  // small placeholder so the thread doesn't hang.
  if (!audit.claudeSessionId) {
    const fallback = await persistAgentRow(
      db,
      auditId,
      "(no captured agent session — ask once more, or open a new audit to re-grow context)",
    );
    return { comment: fallback, newSessionId: null, errorMessage: null };
  }

  try {
    const reply = await invokeClaudeJson(
      `Operator just asked a follow-up on the audit report:\n\n${operatorBody.trim()}\n\nReply in 1–3 short paragraphs of markdown. Do not re-emit the JSON envelope; just prose.`,
      {
        budgetSeconds: getAgentBudgetSeconds(),
        resumeSessionId: audit.claudeSessionId ?? undefined,
      },
    );
    if (reply.metrics) {
      await recordClaudeMetrics({
        db,
        ownerKind: "audit_comment",
        ownerId: audit.id,
        projectId: audit.projectId,
        metrics: reply.metrics,
      });
    }
    const text = reply.text.trim();
    const row = await persistAgentRow(
      db,
      auditId,
      text.length > 0 ? text : "(agent returned an empty reply)",
    );
    if (reply.sessionId && reply.sessionId !== audit.claudeSessionId) {
      await db
        .update(schema.audits)
        .set({ claudeSessionId: reply.sessionId })
        .where(eq(schema.audits.id, audit.id));
    }
    return {
      comment: row,
      newSessionId: reply.sessionId ?? null,
      errorMessage: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const row = await persistAgentRow(db, auditId, `(follow-up failed: ${message.slice(0, 240)})`);
    return { comment: row, newSessionId: null, errorMessage: message };
  }
}

async function persistAgentRow(db: Db, auditId: string, body: string): Promise<AuditCommentRow> {
  const id = createId();
  const createdAt = Date.now();
  await db.insert(schema.auditComments).values({
    id,
    auditId,
    role: "agent",
    body,
    createdAt,
  });
  return { id, auditId, role: "agent", body, createdAt };
}
