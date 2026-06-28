import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import type { EventBus } from "../events.ts";

/**
 * Streaming parser for `factory-decision` blocks emitted mid-run by the
 * agent. Each block is a fenced JSON object that surfaces an architectural,
 * library, naming, scope, or tradeoff decision the agent made — not as a
 * blocker, just for operator awareness. Run continues; operator reviews the
 * decision asynchronously from the inbox.
 *
 * The parser is stateful per run: it remembers which decision ids it's
 * already persisted so re-emissions (re-streamed text, agent retries) don't
 * duplicate inbox cards. Re-emitting the same id WITH changes is treated as
 * an update (rare; reserved for a future "agent revised its choice" path).
 */

export type AgentDecisionKind = "architectural" | "library" | "naming" | "scope" | "tradeoff";

/**
 * How the agent expects the operator's override (if any) to look.
 *
 * - `single` (default): `options` is a closed set, exactly one chosen.
 *   Operator can pick a different one or write custom text.
 * - `multi`: `options` is a multi-select set, one or more chosen.
 *   Operator can change which subset is selected, or write custom.
 * - `free`: no `options`; `decided` is a free-form answer. Operator
 *   can ratify or replace with their own text.
 */
export type AgentDecisionResponseType = "single" | "multi" | "free";

export interface AgentDecisionOption {
  title: string;
  tradeoff: string;
  chosen: boolean;
}

export interface AgentDecisionPayload {
  /** Stable id chosen by the agent — `dec-001`, `dec-002`, etc. */
  id: string;
  kind: AgentDecisionKind;
  responseType: AgentDecisionResponseType;
  summary: string;
  context: string;
  options: AgentDecisionOption[];
  decided: string;
  reasoning: string;
}

const FENCE_RE = /```\s*factory-decision\s*\n([\s\S]*?)```/gi;

interface MaybeOption {
  title?: unknown;
  tradeoff?: unknown;
  chosen?: unknown;
}

interface MaybePayload {
  id?: unknown;
  kind?: unknown;
  responseType?: unknown;
  summary?: unknown;
  context?: unknown;
  options?: unknown;
  decided?: unknown;
  reasoning?: unknown;
}

function coerceKind(raw: unknown): AgentDecisionKind {
  if (
    raw === "architectural" ||
    raw === "library" ||
    raw === "naming" ||
    raw === "scope" ||
    raw === "tradeoff"
  ) {
    return raw;
  }
  return "tradeoff";
}

function coerceOptions(raw: unknown): AgentDecisionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is MaybeOption => Boolean(o) && typeof o === "object")
    .map((o) => ({
      title: typeof o.title === "string" ? o.title : "(unnamed option)",
      tradeoff: typeof o.tradeoff === "string" ? o.tradeoff : "",
      chosen: o.chosen === true,
    }));
}

function coerceResponseType(
  raw: unknown,
  options: AgentDecisionOption[],
): AgentDecisionResponseType {
  if (raw === "multi" || raw === "free" || raw === "single") return raw;
  // No explicit responseType → infer from option shape. No options at all
  // ⇒ free-form. Multiple chosen ⇒ multi. Otherwise single.
  if (options.length === 0) return "free";
  const chosenCount = options.filter((o) => o.chosen).length;
  if (chosenCount > 1) return "multi";
  return "single";
}

function coerce(raw: unknown): AgentDecisionPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as MaybePayload;
  const id = typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id.trim() : null;
  if (!id) return null;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (summary.length === 0) return null;
  const options = coerceOptions(obj.options);
  const responseType = coerceResponseType(obj.responseType, options);
  // Decided is canonical even when the agent didn't mark options[].chosen.
  // For single: fall back to first chosen, then first option, then literal.
  // For multi: comma-join chosen titles if decided is missing.
  // For free: there's only the decided text.
  let decided: string;
  if (typeof obj.decided === "string" && obj.decided.trim().length > 0) {
    decided = obj.decided.trim();
  } else if (responseType === "multi") {
    const chosen = options.filter((o) => o.chosen).map((o) => o.title);
    decided = chosen.length > 0 ? chosen.join(", ") : "(unspecified)";
  } else {
    decided = options.find((o) => o.chosen)?.title ?? options[0]?.title ?? "(unspecified)";
  }
  return {
    id,
    kind: coerceKind(obj.kind),
    responseType,
    summary: summary.slice(0, 240),
    context: typeof obj.context === "string" ? obj.context : "",
    options,
    decided,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
  };
}

/**
 * Find every `factory-decision` block in `text` and return its parsed
 * payload + the byte-offset range it occupies in the text. Used by the
 * stateful streaming wrapper below to dedupe.
 */
export function extractAgentDecisions(text: string): AgentDecisionPayload[] {
  const out: AgentDecisionPayload[] = [];
  // Reset regex state — RE has /g flag and shares lastIndex across calls
  // that don't go through exec(). Using matchAll which creates a fresh
  // iterator avoids that bug.
  for (const m of text.matchAll(FENCE_RE)) {
    const body = m[1];
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const payload = coerce(parsed);
    if (payload) out.push(payload);
  }
  return out;
}

export interface AgentDecisionState {
  /** Per-run set of agent-supplied ids we've already persisted. */
  processedIds: Set<string>;
}

export function newAgentDecisionState(): AgentDecisionState {
  return { processedIds: new Set() };
}

export interface PersistAgentDecisionsArgs {
  db: Db;
  events: EventBus;
  runId: string;
  taskId: string | null;
  projectId: string;
  /** Accumulated agent text up to this point. The parser scans the whole
   *  buffer each call but only acts on previously-unseen ids. */
  agentText: string;
  state: AgentDecisionState;
  /**
   * Trust Ladder L2+ (ADR-012): when true, the fork is recorded `auto_ratified`
   * (decided by the agent, out of the pending inbox) instead of `pending`. It
   * stays in history and overridable — the run never paused either way.
   */
  autoRatify?: boolean;
  /** Override `Date.now()` in tests. */
  now?: () => number;
}

export interface PersistAgentDecisionsResult {
  /** New decision rows that were inserted on this call. */
  inserted: Array<{ decisionId: string; payload: AgentDecisionPayload }>;
}

/**
 * Scan the accumulated agent text for new `factory-decision` blocks,
 * persist them as `agent_decision` decisions, and broadcast on the inbox
 * channel. Caller is expected to invoke this on each text-event tick (or
 * at end of run as a fallback). Idempotent: dedupes by agent-supplied id.
 *
 * Decisions are non-blocking. The run does not pause; the operator
 * reviews asynchronously.
 */
export async function persistAgentDecisions(
  args: PersistAgentDecisionsArgs,
): Promise<PersistAgentDecisionsResult> {
  const now = (args.now ?? Date.now)();
  const decisions = extractAgentDecisions(args.agentText);
  const inserted: Array<{ decisionId: string; payload: AgentDecisionPayload }> = [];

  for (const payload of decisions) {
    if (args.state.processedIds.has(payload.id)) continue;
    args.state.processedIds.add(payload.id);

    const decisionId = createId();
    try {
      await args.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "agent_decision",
        projectId: args.projectId,
        outcome: `decided: ${payload.decided.slice(0, 80)}`,
        payload: {
          ...payload,
          runId: args.runId,
          taskId: args.taskId,
        },
        status: args.autoRatify ? "auto_ratified" : "pending",
        createdAt: now,
      });
    } catch (err) {
      console.warn(
        `[agent-decisions] failed to persist ${payload.id} on run ${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    args.events.publish({
      channel: "inbox",
      kind: "decision_created",
      decisionId,
      projectId: args.projectId,
    });
    inserted.push({ decisionId, payload });
  }

  return { inserted };
}
