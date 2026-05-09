import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { claudeCodeAgent, type StreamEvent } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { and, desc, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { recordClaudeMetrics } from "../metrics/record.ts";
import { selectRubricKey } from "./select-rubric.ts";

export interface TriageInput {
  ideaId: string;
  rawText: string;
  intentCeremony?: "tinker" | "personal" | "shared" | "production" | null;
  intentRole?: "owner" | "contributor" | null;
}

/** A single rubric-axis score with anchored evidence. */
export interface TriageAxisScore {
  id: string;
  score: number;
  rationale: string;
  /**
   * Verbatim phrase from the rubric anchor band the agent decided this score
   * satisfies (e.g. "9-10: operator names 3+ specific recent moments").
   * Optional for backward compat with v1-prompted decisions; required by
   * v2 prompts.
   */
  anchor_band_hit?: string;
  /**
   * Quoted or paraphrased signal from the idea text or thread that the
   * score is anchored on, or a named absence of evidence. Optional for
   * backward compat; v2 prompts require it.
   */
  evidence?: string;
}

/** A structured clarifying question emitted on `decompose`. */
export interface TriageDecomposeQuestion {
  question: string;
  /** Rubric axis id that this answer would unblock. */
  blocking_axis: string;
  /** One-line description of what shape of answer would unblock scoring. */
  expected_signal: string;
}

export interface TriageDecisionPayload {
  outcome: "greenlit" | "parked" | "trashed" | "decompose";
  weighted_score?: number;
  uncertainty?: number;
  axes?: TriageAxisScore[];
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
  /**
   * Legacy flat-string clarifying questions. Kept for backward compat with
   * v1-prompted decisions; prefer `decompose_questions`. Both fields may be
   * present during the migration window — readers should prefer the
   * structured shape and fall back to strings.
   */
  clarifying_questions?: string[];
  /** Structured clarifying questions emitted by v2-prompted decisions. */
  decompose_questions?: TriageDecomposeQuestion[];
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
  /**
   * Wall-clock cap. Default: `agentBudgetSeconds` from config (0 = unlimited).
   */
  budgetSeconds?: number;
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

interface TriageInvocation {
  text: string;
  metrics: import("@factory/runtime").AgentMetrics | null;
}

async function invokeClaudeJson(prompt: string, budgetSeconds: number): Promise<TriageInvocation> {
  const ac = new AbortController();
  // budgetSeconds=0 means unlimited (matches running the Claude CLI directly).
  const timer = budgetSeconds > 0 ? setTimeout(() => ac.abort(), budgetSeconds * 1000) : null;

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

  // Concatenate every text event — assistant blocks and the final result
  // envelope. Duplicates are harmless: the JSON extractor finds the first
  // balanced object regardless of surrounding noise.
  let resultText = "";
  let metrics: import("@factory/runtime").AgentMetrics | null = null;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleEvents = (events: readonly StreamEvent[]) => {
    for (const e of events) {
      if (e.kind === "text") resultText += e.text;
      else if (e.kind === "metrics") metrics = e.metrics;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleEvents(claudeCodeAgent.parseLine(line));
        idx = buf.indexOf("\n");
      }
    }
    if (buf.length > 0) {
      handleEvents(claudeCodeAgent.parseLine(buf));
    }
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !resultText) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
  }
  return { text: resultText, metrics };
}

/**
 * Walk `text` and return the first balanced `{...}` object as a string.
 * Tracks string boundaries and escapes so braces inside JSON string values
 * don't throw the depth count off. Returns null if no balanced object is
 * found — handles the case where the agent emitted prose containing braces
 * before the JSON, or wrapped its answer in a Markdown fence we missed.
 */
function findBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          return text.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

function extractJson(text: string): TriageDecisionPayload {
  // Try the raw text first — bracket-walking handles prose-around-JSON.
  // Fall back to fenced-block extraction if the raw text doesn't yield a
  // balanced object (some agents wrap the JSON in ```json … ``` despite the
  // prompt's instructions).
  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
  while ((match = fence.exec(text)) !== null) {
    candidates.push(match[1] ?? "");
  }

  let firstParseError: string | null = null;
  for (const candidate of candidates) {
    const slice = findBalancedJsonObject(candidate);
    if (!slice) continue;
    try {
      return JSON.parse(slice) as TriageDecisionPayload;
    } catch (err) {
      if (firstParseError === null) {
        firstParseError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const head = text.slice(0, 240).replace(/\s+/g, " ").trim();
  const detail = firstParseError ? `JSON parse error: ${firstParseError}` : "no balanced JSON";
  throw new Error(`${detail} (agent output len=${text.length}, head: ${head})`);
}

export async function runTriage(
  db: Db,
  input: TriageInput,
  opts: TriageOptions = {},
): Promise<{ decisionId: string; payload: TriageDecisionPayload }> {
  // 1. Load rubric (selected from intentCeremony × intentRole) + prompt.
  const rubricKey = selectRubricKey({
    ceremony: input.intentCeremony ?? null,
    role: input.intentRole ?? null,
  });
  const rubric = await db
    .select()
    .from(schema.rubricVersions)
    .where(
      and(eq(schema.rubricVersions.rubricKey, rubricKey), eq(schema.rubricVersions.active, true)),
    )
    .orderBy(desc(schema.rubricVersions.version))
    .get();
  if (!rubric) {
    throw new Error(`no active rubric for key ${rubricKey} — did you run \`bun run seed\`?`);
  }

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
    INTENT_CEREMONY: input.intentCeremony ?? "null",
    INTENT_ROLE: input.intentRole ?? "null",
    RUBRIC_YAML: rubric.yaml,
  });

  // 3. Invoke the agent.
  const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();
  let responseText: string;
  let metrics: import("@factory/runtime").AgentMetrics | null = null;
  if (opts.agentInvoker) {
    responseText = await opts.agentInvoker(rendered);
  } else {
    const inv = await invokeClaudeJson(rendered, budget);
    responseText = inv.text;
    metrics = inv.metrics;
  }

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

  if (metrics) {
    await recordClaudeMetrics({
      db,
      ownerKind: "triage",
      ownerId: decisionId,
      projectId: null,
      metrics,
      now,
    });
  }

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

  const rubricKey = selectRubricKey({
    ceremony: idea.intentCeremony ?? null,
    role: idea.intentRole ?? null,
  });
  const rubric = decision.rubricVersionId
    ? await db
        .select()
        .from(schema.rubricVersions)
        .where(eq(schema.rubricVersions.id, decision.rubricVersionId))
        .get()
    : await db
        .select()
        .from(schema.rubricVersions)
        .where(
          and(
            eq(schema.rubricVersions.rubricKey, rubricKey),
            eq(schema.rubricVersions.active, true),
          ),
        )
        .orderBy(desc(schema.rubricVersions.version))
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
    INTENT_CEREMONY: idea.intentCeremony ?? "null",
    INTENT_ROLE: idea.intentRole ?? "null",
    RUBRIC_YAML: rubric.yaml,
    PRIOR_DECISION_JSON: JSON.stringify(priorPayload, null, 2),
    THREAD: threadText.length > 0 ? threadText : "(no prior messages)",
  });

  const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();
  let responseText: string;
  let metrics: import("@factory/runtime").AgentMetrics | null = null;
  if (opts.agentInvoker) {
    responseText = await opts.agentInvoker(rendered);
  } else {
    const inv = await invokeClaudeJson(rendered, budget);
    responseText = inv.text;
    metrics = inv.metrics;
  }

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

  if (metrics) {
    await recordClaudeMetrics({
      db,
      ownerKind: "triage",
      ownerId: decisionId,
      projectId: null,
      metrics,
      now,
    });
  }

  return { decisionId, payload, agentCommentId, verdictChanged };
}
