import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { asc, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { BOT_COMMENT_MARKER, factoryLinkFooter } from "../github/issue-triage.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { type InvokeClaudeResult, invokeClaudeJson } from "../plans/invoke-claude.ts";
import { postIssueComment } from "../projects/github-task-store.ts";

/**
 * The operator ↔ Factory dialog for `blocked_run` / `needs_review` /
 * `agent_decision` decisions. Brings these decision kinds up to the
 * conversational parity that `triage` and `issue_intake` already have: an
 * operator comment gets a live agent reply (not silent storage), and — for a
 * github-issues-backed task — the exchange mirrors to the issue thread as
 * `factory[bot]` so the conversation is a dialog, not a soliloquy.
 *
 * The reply is prose, not a structured draft (unlike `runIssueIntakeReply`):
 * a blocked run is being unblocked, an agent decision is being defended or
 * adjusted — neither produces a new plan/task suggestion here. The blocked_run
 * retry still folds the operator's answers into `operatorContext` on approve;
 * this reply is additive and never touches that path (the retry folds only
 * `role==="operator"` comments).
 */

export interface DialogProject {
  id: string;
  agent?: string | null;
  taskBackend?: string | null;
  githubRemote?: string | null;
  githubInstallationId?: number | null;
}

export interface DecisionReplyDeps {
  db: Db;
  events: EventBus;
  config: FactoryConfig;
  project: DialogProject;
}

export interface DecisionReplyOptions {
  /** Test seam — replaces the real claude invocation. */
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
  /** Skip echoing the agent reply to the GitHub issue (test seam / dedupe). */
  skipGithubEcho?: boolean;
  budgetSeconds?: number;
}

export interface DecisionReplyResult {
  body: string;
  errorMessage: string | null;
}

interface DialogPayload {
  taskId?: string | null;
  runId?: string;
  summary?: string;
  questions?: string[];
  context?: string;
  decided?: string;
  reasoning?: string;
  options?: Array<{ title?: string; tradeoff?: string; chosen?: boolean }>;
  failed?: boolean;
  needsReview?: boolean;
  [k: string]: unknown;
}

/** The github issue number for a decision, or null when not github-backed. */
function issueNumberFor(project: DialogProject, payload: DialogPayload): string | null {
  if (project.taskBackend !== "github-issues") return null;
  const taskId = payload.taskId;
  return typeof taskId === "string" && /^\d+$/.test(taskId) ? taskId : null;
}

function renderThread(thread: { role: string; body: string }[]): string {
  return thread.length === 0
    ? "(no replies yet)"
    : thread.map((c) => `### ${c.role}\n\n${c.body}`).join("\n\n");
}

function buildBlockedRunPrompt(
  payload: DialogPayload,
  thread: { role: string; body: string }[],
): string {
  const framing = payload.failed
    ? "A run you executed on a task FAILED, and the operator is giving you context for the retry."
    : payload.needsReview
      ? "A run you executed exited with committed work the operator needs to review, and they have replied."
      : "A run you executed on a task BLOCKED — you surfaced questions to the operator, who has now replied.";
  const questionsBlock =
    payload.questions && payload.questions.length > 0
      ? `## Questions you raised\n\n${payload.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n`
      : "";
  return [
    `You are an AI engineering assistant for an internal tool called "Factory". ${framing}`,
    "",
    "## The run",
    payload.summary && payload.summary.length > 0 ? payload.summary : "(no summary)",
    "",
    `${questionsBlock}## Conversation so far`,
    renderThread(thread),
    "",
    "## Your turn",
    "Reply to the operator in 1-3 short paragraphs of markdown. Acknowledge their answers, confirm whether they unblock you, and say concretely what you'll do on the retry — or ask one focused follow-up if something is still ambiguous. Do not write code; this is a conversation to align before the retry run.",
  ].join("\n");
}

function buildAgentDecisionPrompt(
  payload: DialogPayload,
  thread: { role: string; body: string }[],
): string {
  const optionsBlock =
    payload.options && payload.options.length > 0
      ? `## Options you considered\n\n${payload.options
          .map(
            (o) =>
              `- ${o.title ?? "(untitled)"}${o.tradeoff ? ` — ${o.tradeoff}` : ""}${o.chosen ? " **(chosen)**" : ""}`,
          )
          .join("\n")}\n\n`
      : "";
  return [
    'You are an AI engineering assistant for an internal tool called "Factory". During a run you made an autonomous decision and surfaced it to the operator for review. The operator has replied — often asking why, or pushing back. Respond conversationally.',
    "",
    "## The decision you made",
    `Summary: ${payload.summary ?? "(none)"}`,
    payload.context ? `Context: ${payload.context}` : "",
    `Decided: ${payload.decided ?? "(none)"}`,
    payload.reasoning ? `Reasoning: ${payload.reasoning}` : "",
    "",
    `${optionsBlock}## Conversation so far`,
    renderThread(thread),
    "",
    "## Your turn",
    "Reply in 1-3 short paragraphs of markdown. Explain or defend your reasoning, or — if the operator prefers a different option — acknowledge it and describe concretely how the work would change under their preference. Be direct and concise; do not emit code.",
  ].join("\n");
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

/**
 * Echo an operator's PWA-authored comment onto the task's GitHub issue so the
 * github-side thread mirrors the inbox conversation. No-op for file-backed
 * projects or non-numeric task ids. Best-effort; never throws.
 */
export async function echoOperatorCommentToIssue(
  config: Pick<FactoryConfig, "githubApp">,
  project: DialogProject,
  payload: DialogPayload,
  body: string,
): Promise<void> {
  const issueNumber = issueNumberFor(project, payload);
  if (!issueNumber) return;
  await postIssueComment(
    config,
    project,
    issueNumber,
    `**Operator:**\n\n${body}\n\n${BOT_COMMENT_MARKER}`,
  ).catch(() => false);
}

/**
 * Run the conversational reply agent on a `blocked_run` / `agent_decision`
 * decision: build a kind-aware prose prompt over the comment thread, persist
 * the agent's reply as a decision comment, and — unless suppressed — echo it to
 * the GitHub issue as `factory[bot]`. Best-effort on the echo; never throws on
 * a GitHub failure.
 */
export async function runDecisionReply(
  deps: DecisionReplyDeps,
  decisionId: string,
  opts: DecisionReplyOptions = {},
): Promise<DecisionReplyResult> {
  const { db, config, project } = deps;
  const decision = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId))
    .get();
  if (!decision) return { body: "", errorMessage: "decision not found" };
  if (decision.kind !== "blocked_run" && decision.kind !== "agent_decision") {
    return { body: "", errorMessage: `runDecisionReply does not handle ${decision.kind}` };
  }

  const payload = (decision.payload ?? {}) as DialogPayload;
  const thread = await db
    .select({ role: schema.decisionComments.role, body: schema.decisionComments.body })
    .from(schema.decisionComments)
    .where(eq(schema.decisionComments.decisionId, decisionId))
    .orderBy(asc(schema.decisionComments.createdAt))
    .all();

  const prompt =
    decision.kind === "blocked_run"
      ? buildBlockedRunPrompt(payload, thread)
      : buildAgentDecisionPrompt(payload, thread);
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
    await persistAgentComment(db, decisionId, `(reply failed: ${message.slice(0, 240)})`);
    return { body: "", errorMessage: message };
  }

  if (invocation.metrics) {
    await recordAgentMetrics({
      db,
      ownerKind: "audit_comment", // reuses the comment-metrics enum slot, as issue-triage does
      ownerId: decisionId,
      projectId: project.id,
      agent,
      metrics: invocation.metrics,
    });
  }

  const text = invocation.text.trim();
  const body = text.length > 0 ? text : "(agent returned an empty reply)";
  await persistAgentComment(db, decisionId, body);

  if (!opts.skipGithubEcho) {
    const issueNumber = issueNumberFor(project, payload);
    if (issueNumber) {
      const footer = factoryLinkFooter(config.publicBaseUrl, [
        { label: "review in inbox", path: `/decisions/${decisionId}` },
        { label: "project", path: `/projects/${project.id}` },
      ]);
      await postIssueComment(
        config,
        project,
        issueNumber,
        `${body}${footer}\n\n${BOT_COMMENT_MARKER}`,
      ).catch(() => false);
    }
  }

  return { body, errorMessage: null };
}
