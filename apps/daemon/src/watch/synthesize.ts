import { watchObservationKindEnum, watchObservationProposalEnum } from "@factory/db";
import { invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import type { MemoryDoc, WorkRecord } from "./sources/types.ts";

/**
 * The synthesizer (ADR-010 §3): turn a batch of out-of-band `WorkRecord`s (+ on
 * first encounter, a source's existing memories) into high-signal observations.
 *
 * The LLM call is injectable so the parse / validate / null-parse-fail logic is
 * testable without spawning a CLI. The default invoker is a one-shot
 * `claude --print` via `invokeClaudeJson` — same discipline as triage / plan
 * iteration (fenced JSON, throw when nothing parseable).
 */

export interface ObservationEvidence {
  sourceId: string;
  sessionId: string;
}

export interface RawObservation {
  kind: (typeof watchObservationKindEnum)[number];
  title: string;
  detail: string;
  evidence: ObservationEvidence[];
  proposal: (typeof watchObservationProposalEnum)[number];
  /** Factory project slug, or null for an operator-level (cross-project) insight. */
  targetProjectSlug: string | null;
}

export type InvokeFn = (prompt: string) => Promise<string>;

export interface SynthesizeDeps {
  /** Defaults to a one-shot `claude --print` invocation. */
  invoke?: InvokeFn;
  /** Wall-clock budget for the default invoker (0 = unlimited). */
  budgetSeconds?: number;
  /** Cap on records fed to the model, bounding token cost. */
  maxRecords?: number;
}

export async function synthesizeObservations(
  records: WorkRecord[],
  memories: MemoryDoc[],
  deps: SynthesizeDeps = {},
): Promise<RawObservation[]> {
  if (records.length === 0) return [];
  const invoke = deps.invoke ?? defaultInvoke(deps.budgetSeconds ?? 0);
  const prompt = buildSynthesisPrompt(records, memories, deps.maxRecords ?? 80);
  const text = await invoke(prompt);
  // Throws when nothing parseable — the honest null-parse-fail contract. The
  // caller (the job) leaves cursors uncommitted so the batch is retried.
  const parsed = extractJsonObject<{ observations?: unknown }>(text);
  return validateObservations(parsed.observations);
}

function defaultInvoke(budgetSeconds: number): InvokeFn {
  return async (prompt) => {
    const { text } = await invokeClaudeJson(prompt, { budgetSeconds, agent: "claude-code" });
    return text;
  };
}

export function buildSynthesisPrompt(
  records: WorkRecord[],
  memories: MemoryDoc[],
  maxRecords: number,
): string {
  // Records arrive oldest→newest; keep the most recent within budget.
  const recent = records.slice(-maxRecords);
  const recordLines = recent
    .map((r) => {
      const when = new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ");
      const project = r.projectPath ?? "—";
      return `- [${r.sourceId}] session=${r.sessionId} | ${when} | project=${project} | ${r.title} (${r.summary})`;
    })
    .join("\n");

  const memoryBlock = memories.length
    ? `\n\nEXISTING MEMORY (already known — do NOT re-surface these as new; use them only to avoid duplicating what's recorded):\n${memories
        .map((m) => `### ${m.title}\n${m.body.trim().slice(0, 1200)}`)
        .join("\n\n")}`
    : "";

  return `You are The Watch — Heimdall's synthesizing eye over the operator's engineering work.

You are given a batch of recent work sessions the operator ran OUTSIDE the Factory
orchestrator (in Claude Code, Codex, etc.). Your job is to surface a small number of
HIGH-SIGNAL observations the operator may not see themselves — recurring rituals they
do by hand, new conventions worth recording, repeated corrections, concrete tasks
worth queuing, or tooling gaps.

Be precise, not exhaustive. Prefer FEW strong observations over many weak ones. If a
batch is unremarkable, return an empty array. Never invent work not present in the
sessions. Every observation must cite the sessions it came from (by source + session
id, drawn ONLY from the list below).

WORK SESSIONS (oldest → newest):
${recordLines}${memoryBlock}

Respond with ONE fenced \`\`\`json block, no prose, matching exactly:
{
  "observations": [
    {
      "kind": "repeated-ritual" | "new-convention" | "correction-pattern" | "candidate-task" | "tooling-gap",
      "title": "<≤80 char summary>",
      "detail": "<1-3 sentences: what you saw and why it matters>",
      "evidence": [ { "sourceId": "<source>", "sessionId": "<id from the list>" } ],
      "proposal": "adopt-as-task" | "record-as-convention" | "note-only",
      "targetProjectSlug": "<repo slug if it clearly maps to one project, else null>"
    }
  ]
}

Guidance: use "adopt-as-task" only when there is a concrete, ownable unit of work;
"record-as-convention" when it's a durable preference/pattern worth remembering;
otherwise "note-only". Default to "note-only" when unsure.`;
}

function validateObservations(raw: unknown): RawObservation[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set<string>(watchObservationKindEnum);
  const proposals = new Set<string>(watchObservationProposalEnum);
  const out: RawObservation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    const proposal = String(o.proposal ?? "");
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const detail = typeof o.detail === "string" ? o.detail.trim() : "";
    if (!kinds.has(kind) || !proposals.has(proposal) || !title || !detail) continue;
    const evidence = Array.isArray(o.evidence)
      ? o.evidence.flatMap((e): ObservationEvidence[] => {
          if (!e || typeof e !== "object") return [];
          const ev = e as Record<string, unknown>;
          const sourceId = String(ev.sourceId ?? "");
          const sessionId = String(ev.sessionId ?? "");
          return sourceId && sessionId ? [{ sourceId, sessionId }] : [];
        })
      : [];
    const slug = typeof o.targetProjectSlug === "string" ? o.targetProjectSlug.trim() : "";
    out.push({
      kind: kind as RawObservation["kind"],
      title: title.slice(0, 80),
      detail,
      evidence,
      proposal: proposal as RawObservation["proposal"],
      targetProjectSlug: slug || null,
    });
  }
  return out;
}
