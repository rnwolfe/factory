import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { type InvokeClaudeResult, invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import { postIssueComment } from "../projects/github-task-store.ts";

/**
 * Issue-intake triage parity (task-048). Brings the github-issues task backend
 * up to the file backend's behavior: when an external issue lands in the inbox
 * it is auto-triaged with a plan/task suggestion, and operator comments (from
 * the PWA or from GitHub) get an agent reply. The reply is echoed back to the
 * GitHub issue thread as `factory[bot]` so the conversation lives in both
 * places. Mirrors `feedback/iterate.ts`, but stores on `decision_comments`
 * and targets a github-issues-backed project.
 */

/** Hidden marker appended to every bot-echoed comment so inbound webhooks for
 * the bot's own comments can be skipped (loop guard). */
export const BOT_COMMENT_MARKER = "<!-- factory:bot -->";

export interface IssueDraft {
  kind: "plan" | "task" | "dismiss";
  title: string;
  summary: string;
  reasoning: string;
}

export interface IssueIntakeProject {
  id: string;
  agent?: string | null;
  taskBackend?: string | null;
  githubRemote?: string | null;
  githubInstallationId?: number | null;
}

export interface IssueIntakeReplyDeps {
  db: Db;
  events: EventBus;
  config: FactoryConfig;
  project: IssueIntakeProject;
}

export interface IssueIntakeReplyOptions {
  /** Test seam — replaces the real claude invocation. */
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
  /** Skip echoing the agent reply to the GitHub issue (test seam / dedupe). */
  skipGithubEcho?: boolean;
  budgetSeconds?: number;
}

export interface IssueIntakeReplyResult {
  draft: IssueDraft | null;
  body: string;
  errorMessage: string | null;
}

interface IssueIntakePayload {
  number?: number;
  title?: string;
  author?: string;
  htmlUrl?: string;
  body?: string;
  /** Latest agent suggestion, mirrored onto the decision so the card renders it. */
  draft?: IssueDraft;
  [k: string]: unknown;
}

/** Append an operator-authored comment to an issue_intake decision thread. */
export async function appendOperatorComment(
  db: Db,
  decisionId: string,
  body: string,
): Promise<void> {
  await db.insert(schema.decisionComments).values({
    id: createId(),
    decisionId,
    role: "operator",
    body,
    createdAt: Date.now(),
  });
}

function coerceDraft(raw: Record<string, unknown>): IssueDraft | null {
  const kind = raw.kind;
  if (kind !== "plan" && kind !== "task" && kind !== "dismiss") return null;
  return {
    kind,
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning.trim() : "",
  };
}

function buildPrompt(
  payload: IssueIntakePayload,
  thread: { role: string; body: string }[],
): string {
  const threadMd =
    thread.length === 0
      ? "(no replies yet)"
      : thread.map((c) => `### ${c.role}\n\n${c.body}`).join("\n\n");
  return [
    'You are an AI engineering assistant helping the operator of an internal tool called "Factory" triage a GitHub issue that was filed on one of their projects.',
    "",
    "## The issue",
    `#${payload.number ?? "?"} — ${payload.title ?? "(untitled)"}`,
    `Filed by: ${payload.author ?? "unknown"}`,
    "",
    payload.body && payload.body.length > 0 ? payload.body : "(no description)",
    "",
    "## Thread so far",
    threadMd,
    "",
    "## Your turn",
    "Reply to the operator in 1-3 short paragraphs of markdown explaining how you read the issue and what you'd do about it. Then, on a new line, emit a fenced JSON block with this shape exactly:",
    "",
    "```json",
    '{"kind": "plan" | "task" | "dismiss", "title": "...", "summary": "...", "reasoning": "..."}',
    "```",
    "",
    "Pick `plan` for substantive work that needs decomposition; `task` for a single discrete change; `dismiss` if the issue isn't actionable (spam, duplicate, out of scope). Keep title under 80 chars; summary as 2-5 lines of markdown.",
  ].join("\n");
}

/**
 * Run the triage/reply agent on an issue_intake decision, persist the agent's
 * reply as a decision comment, mirror the structured draft onto the decision
 * payload (so the inbox card shows the suggestion), and — unless suppressed —
 * echo the reply to the GitHub issue as `factory[bot]`. Best-effort on the
 * echo; never throws on a GitHub failure.
 */
export async function runIssueIntakeReply(
  deps: IssueIntakeReplyDeps,
  decisionId: string,
  opts: IssueIntakeReplyOptions = {},
): Promise<IssueIntakeReplyResult> {
  const { db, config, project } = deps;
  const decision = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId))
    .get();
  if (!decision) return { draft: null, body: "", errorMessage: "decision not found" };

  const payload = (decision.payload ?? {}) as IssueIntakePayload;
  const thread = await db
    .select({ role: schema.decisionComments.role, body: schema.decisionComments.body })
    .from(schema.decisionComments)
    .where(eq(schema.decisionComments.decisionId, decisionId))
    .orderBy(asc(schema.decisionComments.createdAt))
    .all();

  const prompt = buildPrompt(payload, thread);
  const agent = resolveAgent(db, { projectAgent: project.agent });

  let invocation: InvokeClaudeResult;
  try {
    invocation = opts.agentInvoker
      ? await opts.agentInvoker(prompt)
      : await invokeClaudeJson(prompt, {
          budgetSeconds: opts.budgetSeconds ?? getAgentBudgetSeconds(),
          agent,
        });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await persistAgentComment(db, decisionId, `(triage failed: ${message.slice(0, 240)})`);
    return { draft: null, body: "", errorMessage: message };
  }

  if (invocation.metrics) {
    await recordAgentMetrics({
      db,
      ownerKind: "audit_comment", // reusing kind enum — issue triage isn't a separate kind yet
      ownerId: decisionId,
      projectId: project.id,
      agent,
      metrics: invocation.metrics,
    });
  }

  const text = invocation.text.trim();
  let draft: IssueDraft | null = null;
  try {
    const parsed = extractJsonObject<Record<string, unknown>>(text);
    if (parsed) draft = coerceDraft(parsed);
  } catch {
    // draft is optional
  }

  const body = text.length > 0 ? text : "(agent returned an empty reply)";
  await persistAgentComment(db, decisionId, body);

  // Mirror the structured suggestion onto the decision payload so the inbox
  // card renders "suggested as a plan/task" without re-reading the thread.
  if (draft) {
    await db
      .update(schema.decisions)
      .set({ payload: { ...payload, draft } })
      .where(eq(schema.decisions.id, decisionId));
  }

  // Echo to the GitHub issue thread as the bot, with the loop-guard marker.
  if (!opts.skipGithubEcho && typeof payload.number === "number") {
    await postIssueComment(
      config,
      project,
      String(payload.number),
      `${body}\n\n${BOT_COMMENT_MARKER}`,
    ).catch(() => false);
  }

  return { draft, body, errorMessage: null };
}

async function persistAgentComment(db: Db, decisionId: string, body: string): Promise<void> {
  await db.insert(schema.decisionComments).values({
    id: createId(),
    decisionId,
    role: "agent",
    body,
    createdAt: Date.now(),
  });
}
