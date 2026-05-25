import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import { recordClaudeMetrics } from "../metrics/record.ts";
import {
  agentSupportsResume,
  type InvokeClaudeResult,
  invokeClaudeJson,
} from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import { setFeedbackSession } from "./store.ts";

const FEEDBACK_PROMPT_KEY = "feedback-iterate-v1";

export interface FeedbackCommentRow {
  id: string;
  feedbackId: string;
  role: "operator" | "agent";
  body: string;
  resultingDraft: string | null;
  createdAt: number;
}

export interface FeedbackDraft {
  /** What the agent recommends doing about this feedback. */
  kind: "plan" | "task" | "dismiss";
  /** Short title for the plan or task. Empty for kind='dismiss'. */
  title: string;
  /** Markdown body / plan summary. Empty for kind='dismiss'. */
  summary: string;
  /** Why the agent picked this kind. */
  reasoning: string;
}

export async function listFeedbackComments(
  db: Db,
  feedbackId: string,
): Promise<FeedbackCommentRow[]> {
  return db
    .select()
    .from(schema.feedbackComments)
    .where(eq(schema.feedbackComments.feedbackId, feedbackId))
    .orderBy(asc(schema.feedbackComments.createdAt))
    .all();
}

export async function appendOperatorComment(
  db: Db,
  feedbackId: string,
  body: string,
): Promise<FeedbackCommentRow> {
  const id = createId();
  const createdAt = Date.now();
  await db.insert(schema.feedbackComments).values({
    id,
    feedbackId,
    role: "operator",
    body,
    createdAt,
  });
  return { id, feedbackId, role: "operator", body, resultingDraft: null, createdAt };
}

export interface AgentReplyOptions {
  /** Test seam — when set, replaces the real claude invocation. */
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
  /** Default 90s. */
  budgetSeconds?: number;
}

export interface AgentReplyResult {
  comment: FeedbackCommentRow | null;
  draft: FeedbackDraft | null;
  errorMessage: string | null;
}

/**
 * Generate the agent's reply on a feedback thread. Builds a self-contained
 * prompt from the feedback row + thread history (no claudeSessionId resume
 * by default — feedback threads are short and the resume contract isn't
 * worth the additional surface). When the agent's reply contains a fenced
 * JSON block conforming to FeedbackDraft, that draft is mirrored on the
 * comment row's `resultingDraft`.
 */
export async function runAgentReply(
  db: Db,
  feedbackId: string,
  opts: AgentReplyOptions = {},
): Promise<AgentReplyResult> {
  const fb = await db
    .select()
    .from(schema.feedback)
    .where(eq(schema.feedback.id, feedbackId))
    .get();
  if (!fb) return { comment: null, draft: null, errorMessage: "feedback not found" };

  const thread = await listFeedbackComments(db, feedbackId);
  const prompt = await buildPrompt(db, fb, thread);

  // Resolve effective agent. Feedback threads relied on resume when present;
  // for agents without resume (codex), drop the resumeSessionId — buildPrompt
  // already encodes the full thread into the prompt, so the agent has the
  // context it needs to reply (just spends more tokens than the resume path
  // would). See docs/internal/codex-parity.md §5a.
  const agent = resolveAgent(db);
  const resumeAllowed = agentSupportsResume(agent);
  const resumeSessionId = resumeAllowed ? (fb.claudeSessionId ?? undefined) : undefined;

  let invocation: InvokeClaudeResult;
  try {
    invocation = opts.agentInvoker
      ? await opts.agentInvoker(prompt)
      : await invokeClaudeJson(prompt, {
          budgetSeconds: opts.budgetSeconds ?? getAgentBudgetSeconds(),
          agent,
          resumeSessionId,
        });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const row = await persistAgentRow(
      db,
      feedbackId,
      `(reply failed: ${message.slice(0, 240)})`,
      null,
    );
    return { comment: row, draft: null, errorMessage: message };
  }

  if (invocation.metrics) {
    await recordClaudeMetrics({
      db,
      ownerKind: "audit_comment", // reusing kind enum — feedback comments aren't a separate kind yet
      ownerId: feedbackId,
      projectId: null,
      metrics: invocation.metrics,
    });
  }

  if (invocation.sessionId && invocation.sessionId !== fb.claudeSessionId) {
    setFeedbackSession(db, feedbackId, invocation.sessionId);
  }

  const text = invocation.text.trim();
  let draft: FeedbackDraft | null = null;
  try {
    const parsed = extractJsonObject<Record<string, unknown>>(text);
    if (parsed) {
      const coerced = coerceDraft(parsed);
      if (coerced) draft = coerced;
    }
  } catch {
    // ignore — draft is optional
  }

  const row = await persistAgentRow(
    db,
    feedbackId,
    text.length > 0 ? text : "(agent returned an empty reply)",
    draft ? JSON.stringify(draft) : null,
  );
  return { comment: row, draft, errorMessage: null };
}

async function persistAgentRow(
  db: Db,
  feedbackId: string,
  body: string,
  resultingDraft: string | null,
): Promise<FeedbackCommentRow> {
  const id = createId();
  const createdAt = Date.now();
  await db.insert(schema.feedbackComments).values({
    id,
    feedbackId,
    role: "agent",
    body,
    resultingDraft,
    createdAt,
  });
  return { id, feedbackId, role: "agent", body, resultingDraft, createdAt };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

const FALLBACK_PROMPT_TEMPLATE = [
  'You are an AI engineering assistant helping the operator of an internal tool called "Factory" iterate on feedback they captured about Factory itself.',
  "",
  "## The feedback",
  "Vote: {{VOTE}}",
  "Captured from: {{CONTEXT_HINT}} — {{CONTEXT_ROUTE}}",
  "",
  "{{BODY}}",
  "",
  "## Thread so far",
  "{{THREAD}}",
  "",
  "## Your turn",
  "Reply to the operator in 1-3 short paragraphs of markdown. Then, on a new line, emit a fenced JSON block describing what you'd recommend doing about this feedback. Use this shape exactly:",
  "",
  "```json",
  '{"kind": "plan" | "task" | "dismiss", "title": "...", "summary": "...", "reasoning": "..."}',
  "```",
  "",
  "Pick `plan` for substantive work that needs decomposition; `task` for a single discrete change; `dismiss` if the feedback isn't actionable. Keep title under 80 chars; summary as 2-5 lines of markdown.",
].join("\n");

async function buildPrompt(
  db: Db,
  fb: typeof schema.feedback.$inferSelect,
  thread: FeedbackCommentRow[],
): Promise<string> {
  const threadMd =
    thread.length === 0
      ? "(no replies yet)"
      : thread.map((c) => `### ${c.role}\n\n${c.body}`).join("\n\n");

  const row = await db
    .select({ content: schema.prompts.content })
    .from(schema.prompts)
    .where(and(eq(schema.prompts.promptKey, FEEDBACK_PROMPT_KEY), eq(schema.prompts.active, true)))
    .get();
  const template = row?.content ?? FALLBACK_PROMPT_TEMPLATE;

  return renderTemplate(template, {
    VOTE: fb.vote,
    CONTEXT_HINT: fb.contextHint ?? "(no hint)",
    CONTEXT_ROUTE: fb.contextRoute ?? "(no route)",
    BODY: fb.body,
    THREAD: threadMd,
  });
}

function coerceDraft(parsed: Record<string, unknown>): FeedbackDraft | null {
  const kind = parsed.kind;
  if (kind !== "plan" && kind !== "task" && kind !== "dismiss") return null;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  return { kind, title, summary, reasoning };
}
