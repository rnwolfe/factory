import { type AgentName, getAgentDescriptor } from "../agents/registry.ts";
import { invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import type { AcceptanceResult } from "./factory-status.ts";

/**
 * Cross-model adversarial validation (ADR-014 / research §D, WS D). Factory already
 * runs two model families ({claude-code, codex}); route each run's verification to
 * the OTHER family, because a model's blind spots correlate with its own output.
 * The verdict becomes the strongest input to the verifier-coverage score.
 *
 * One-shot + read-only: `invokeClaudeJson` is family-agnostic (it resolves the agent
 * through the registry), so this needs no new runtime/auth. The invoker is injectable
 * for tests. Returns `null` on any failure (bad auth, unparseable) — "couldn't
 * validate" is `absent` coverage, never a false `pass`.
 */

export type CrossModelState = "pass" | "concerns" | "fail";

export interface CrossModelVerdict {
  /** The family that performed the validation (the opposite of the builder). */
  validator: AgentName;
  state: CrossModelState;
  /** 0..1 self-reported confidence. */
  confidence: number;
  reasoning: string;
}

/** The validator family for runs `builder` produced — registry-derived (ADR-015). */
export function getValidatorAgent(builder: AgentName): AgentName | null {
  return getAgentDescriptor(builder)?.validatorAgentId ?? null;
}

export type CrossModelInvoke = (prompt: string, agent: AgentName) => Promise<string>;

export interface CrossModelDeps {
  invoke?: CrossModelInvoke;
  budgetSeconds?: number;
  /** cwd for the validator (the run's worktree), so it can resolve repo context. */
  cwd?: string;
}

export interface CrossModelInput {
  builderAgent: AgentName;
  /** Unified diff of the run's changes (already bounded by the caller). */
  diff: string;
  acceptance: AcceptanceResult[];
  taskTitle: string;
  summary: string;
}

export async function crossModelValidate(
  input: CrossModelInput,
  deps: CrossModelDeps = {},
): Promise<CrossModelVerdict | null> {
  const validator = getValidatorAgent(input.builderAgent);
  if (!validator) return null; // family declares no cross-model validator
  const invoke =
    deps.invoke ??
    (async (prompt, agent) => {
      const { text } = await invokeClaudeJson(prompt, {
        agent,
        budgetSeconds: deps.budgetSeconds ?? 0,
        cwd: deps.cwd,
      });
      return text;
    });

  let text: string;
  try {
    text = await invoke(buildCrossModelPrompt(input, validator), validator);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[verifier] cross-model validation via ${validator} failed: ${msg}`);
    return null;
  }
  try {
    const parsed = extractJsonObject<Record<string, unknown>>(text);
    return validateVerdict(parsed, validator);
  } catch {
    return null;
  }
}

export function buildCrossModelPrompt(input: CrossModelInput, validator: AgentName): string {
  const acceptanceBlock = input.acceptance.length
    ? input.acceptance
        .map((a) => `- [${a.met ? "claimed met" : "UNMET"}] ${a.criterion}`)
        .join("\n")
    : "(none declared)";
  // Bound the diff so a huge change can't blow the one-shot budget.
  const diff =
    input.diff.length > 24_000 ? `${input.diff.slice(0, 24_000)}\n…(diff truncated)` : input.diff;

  return `You are an adversarial code reviewer from a DIFFERENT model family than the one that
wrote this change (${validator} reviewing ${input.builderAgent}'s work). Your job is
to independently verify the change is correct and complete — your blind spots differ from
the author's, which is the point.

TASK: ${input.taskTitle}
AUTHOR'S SUMMARY: ${input.summary}

ACCEPTANCE CRITERIA (the author CLAIMS these are met — verify, don't trust):
${acceptanceBlock}

DIFF:
\`\`\`diff
${diff}
\`\`\`

Judge: does the diff actually do what the task + acceptance criteria require, correctly and
without obvious bugs, regressions, or unhandled cases? Be skeptical; default toward
"concerns" when unsure rather than rubber-stamping.

Respond with ONE fenced \`\`\`json block, no prose:
{
  "state": "pass" | "concerns" | "fail",
  "confidence": <0..1>,
  "reasoning": "<≤3 sentences: the strongest concern, or why it's clean>"
}
- "pass": correct and complete, you'd land it unattended.
- "concerns": probably ok but something is unverified/risky — a human should look.
- "fail": a real bug, regression, or unmet criterion.`;
}

/**
 * The run's net diff (its branch tip vs where it branched), bounded by git itself.
 * Empty string on any git failure — the caller treats "no diff" as nothing to review.
 */
export async function getRunDiff(worktreePath: string, baseRef: string | null): Promise<string> {
  const base = baseRef && baseRef.length > 0 ? baseRef : "HEAD~1";
  try {
    const proc = Bun.spawn({
      cmd: ["git", "-C", worktreePath, "diff", base, "HEAD"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch {
    return "";
  }
}

function validateVerdict(
  o: Record<string, unknown>,
  validator: AgentName,
): CrossModelVerdict | null {
  const state = String(o.state ?? "");
  if (state !== "pass" && state !== "concerns" && state !== "fail") return null;
  const confRaw = typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0;
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.trim() : "";
  return { validator, state, confidence, reasoning };
}
