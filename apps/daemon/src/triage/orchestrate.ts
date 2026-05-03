import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { claudeCodeAgent, type StreamEvent } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, eq } from "drizzle-orm";

export interface TriageInput {
  ideaId: string;
  rawText: string;
  goalHint?: string | null;
}

export interface TriageDecisionPayload {
  outcome: "greenlit" | "parked" | "trashed" | "decompose";
  weighted_score?: number;
  uncertainty?: number;
  axes?: Array<{ id: string; score: number; rationale: string }>;
  rationale?: string;
  title_suggestion?: string;
  spec_stub?: {
    summary?: string;
    initial_tasks?: Array<{
      title: string;
      estimate?: "small" | "medium" | "large";
      acceptance?: string[];
    }>;
  };
  clarifying_questions?: string[];
  what_would_change_verdict?: string;
  /** Conversational reply to the operator. Only present on follow-up runs. */
  reply?: string;
}

const FOLLOWUP_PROMPT_KEY = "triage-followup-v1";

export interface TriageOptions {
  /**
   * Override the agent invocation for tests. Receives the rendered prompt and
   * returns the JSON payload string the agent would have produced.
   */
  agentInvoker?: (prompt: string) => Promise<string>;
  /** Wall-clock cap. Default 120s (matches rubric's `max_wall_seconds`). */
  budgetSeconds?: number;
}

const TRIAGE_MAX_BUDGET_SECONDS = 120;

function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

async function invokeClaudeJson(prompt: string, budgetSeconds: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetSeconds * 1000);

  const { argv, stdin } = claudeCodeAgent.buildArgv(prompt, {});
  const proc = bunSpawn({
    cmd: argv as string[],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: ac.signal,
  });
  if (proc.stdin) {
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
    }
    await proc.stdin.end();
  }

  const lines: string[] = [];
  let resultText = "";
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        lines.push(line);
        const events: readonly StreamEvent[] = claudeCodeAgent.parseLine(line);
        for (const e of events) {
          if (e.kind === "text") resultText = e.text;
        }
        idx = buf.indexOf("\n");
      }
    }
    if (buf.length > 0) {
      lines.push(buf);
      const events = claudeCodeAgent.parseLine(buf);
      for (const e of events) if (e.kind === "text") resultText = e.text;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !resultText) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
  }
  return resultText;
}

function extractJson(text: string): TriageDecisionPayload {
  // Strip Markdown code fences if Claude emitted them despite our instructions.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  // Find the outermost {...} block.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in agent output (len=${text.length})`);
  }
  const slice = candidate.slice(start, end + 1);
  return JSON.parse(slice) as TriageDecisionPayload;
}

export async function runTriage(
  db: Db,
  input: TriageInput,
  opts: TriageOptions = {},
): Promise<{ decisionId: string; payload: TriageDecisionPayload }> {
  // 1. Load active rubric + prompt.
  const rubric = await db
    .select()
    .from(schema.rubricVersions)
    .where(eq(schema.rubricVersions.active, true))
    .get();
  if (!rubric) throw new Error("no active rubric — did you run `bun run seed`?");

  const promptRow = await db
    .select()
    .from(schema.prompts)
    .where(and(eq(schema.prompts.promptKey, rubric.promptKey), eq(schema.prompts.active, true)))
    .get();
  if (!promptRow) {
    throw new Error(`no active prompt for key ${rubric.promptKey}`);
  }

  // 2. Render the full prompt.
  const rendered = renderPrompt(promptRow.content, {
    IDEA_TEXT: input.rawText,
    GOAL_HINT: input.goalHint ?? "null",
    RUBRIC_YAML: rubric.yaml,
  });

  // 3. Invoke the agent.
  const budget = Math.min(
    opts.budgetSeconds ?? TRIAGE_MAX_BUDGET_SECONDS,
    TRIAGE_MAX_BUDGET_SECONDS,
  );
  const responseText = opts.agentInvoker
    ? await opts.agentInvoker(rendered)
    : await invokeClaudeJson(rendered, budget);

  // 4. Parse JSON payload.
  const payload = extractJson(responseText);

  // 5. Persist as a decisions row.
  const decisionId = createId();
  const now = Date.now();
  await db.insert(schema.decisions).values({
    id: decisionId,
    kind: "triage",
    ideaId: input.ideaId,
    rubricVersionId: rubric.id,
    outcome: payload.outcome,
    payload,
    uncertainty: payload.uncertainty ?? null,
    weightedScore: payload.weighted_score ?? null,
    status: "pending",
    createdAt: now,
  });

  await db.update(schema.ideas).set({ triagedAt: now }).where(eq(schema.ideas.id, input.ideaId));

  return { decisionId, payload };
}

export interface FollowupTriageOptions extends TriageOptions {
  /** Override the source of "now" for testing. */
  now?: () => number;
}

export interface FollowupTriageResult {
  decisionId: string;
  payload: TriageDecisionPayload;
  /** ID of the agent comment row appended to the thread. */
  agentCommentId: string;
  /** True if the verdict (`outcome`) changed from the prior decision. */
  verdictChanged: boolean;
}

/**
 * Re-run triage for an existing decision after the operator has added a
 * follow-up comment. Loads the decision, idea, and full thread; renders the
 * follow-up prompt; calls the agent; persists the new payload in place; and
 * appends an `agent`-role comment carrying the conversational reply.
 *
 * The decision row is updated rather than versioned: the operator sees the
 * verdict shift on the same card. The thread captures how it got there.
 */
export async function runFollowupTriage(
  db: Db,
  decisionId: string,
  opts: FollowupTriageOptions = {},
): Promise<FollowupTriageResult> {
  const now = (opts.now ?? Date.now)();

  const decision = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId))
    .get();
  if (!decision) throw new Error(`decision ${decisionId} not found`);
  if (decision.kind !== "triage") {
    throw new Error(`follow-up triage only supports triage decisions (got ${decision.kind})`);
  }
  if (!decision.ideaId) throw new Error(`decision ${decisionId} has no ideaId`);

  const idea = await db
    .select()
    .from(schema.ideas)
    .where(eq(schema.ideas.id, decision.ideaId))
    .get();
  if (!idea) throw new Error(`idea ${decision.ideaId} not found`);

  const rubric = decision.rubricVersionId
    ? await db
        .select()
        .from(schema.rubricVersions)
        .where(eq(schema.rubricVersions.id, decision.rubricVersionId))
        .get()
    : await db
        .select()
        .from(schema.rubricVersions)
        .where(eq(schema.rubricVersions.active, true))
        .get();
  if (!rubric) throw new Error("no rubric available for follow-up triage");

  const promptRow = await db
    .select()
    .from(schema.prompts)
    .where(and(eq(schema.prompts.promptKey, FOLLOWUP_PROMPT_KEY), eq(schema.prompts.active, true)))
    .get();
  if (!promptRow) {
    throw new Error(`no active prompt for ${FOLLOWUP_PROMPT_KEY} — re-run \`bun run seed\`?`);
  }

  const thread = await db
    .select()
    .from(schema.decisionComments)
    .where(eq(schema.decisionComments.decisionId, decisionId))
    .orderBy(schema.decisionComments.createdAt)
    .all();

  const threadText = thread
    .map((c) => `[${c.role} · ${new Date(c.createdAt).toISOString()}]\n${c.body}`)
    .join("\n\n");

  const priorPayload = decision.payload as TriageDecisionPayload;

  const rendered = renderPrompt(promptRow.content, {
    IDEA_TEXT: idea.rawText,
    GOAL_HINT: idea.goalHint ?? "null",
    RUBRIC_YAML: rubric.yaml,
    PRIOR_DECISION_JSON: JSON.stringify(priorPayload, null, 2),
    THREAD: threadText.length > 0 ? threadText : "(no prior messages)",
  });

  const budget = Math.min(
    opts.budgetSeconds ?? TRIAGE_MAX_BUDGET_SECONDS,
    TRIAGE_MAX_BUDGET_SECONDS,
  );
  const responseText = opts.agentInvoker
    ? await opts.agentInvoker(rendered)
    : await invokeClaudeJson(rendered, budget);

  const payload = extractJson(responseText);
  const verdictChanged = payload.outcome !== priorPayload.outcome;

  // Persist the updated payload + score + uncertainty + (possibly) outcome on
  // the existing decision row. Status stays `pending` until the operator acts.
  await db
    .update(schema.decisions)
    .set({
      outcome: payload.outcome,
      payload,
      uncertainty: payload.uncertainty ?? null,
      weightedScore: payload.weighted_score ?? null,
    })
    .where(eq(schema.decisions.id, decisionId));

  // The conversational reply is what the operator reads in the thread.
  // Fall back to rationale if the agent didn't emit `reply` (defensive).
  const replyBody =
    payload.reply?.trim() || payload.rationale?.trim() || `Updated verdict: ${payload.outcome}.`;

  const agentCommentId = createId();
  await db.insert(schema.decisionComments).values({
    id: agentCommentId,
    decisionId,
    role: "agent",
    body: replyBody,
    createdAt: now,
  });

  return { decisionId, payload, agentCommentId, verdictChanged };
}
