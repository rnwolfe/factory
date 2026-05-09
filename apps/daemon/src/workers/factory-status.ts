/**
 * Parses the agent's `factory-status` JSON block from the accumulated text
 * stream. The wrap-up footer in `wrapPrompt` instructs the agent to emit
 * exactly one fenced block of the form:
 *
 *     ```factory-status
 *     {"status": "done"|"blocked"|"failed", "summary": "...", "questions": [...]}
 *     ```
 *
 * Real-world model output is messy, so this parser is permissive:
 *   - matches the language tag case-insensitively, with optional whitespace
 *   - falls back to scanning the tail of the text for any balanced JSON
 *     object containing a `status` field
 *   - returns null if no status block was emitted at all (caller should
 *     treat this as `failed` so we never silently mark a run "completed")
 */

export type FactoryStatusKind = "done" | "blocked" | "failed";

/**
 * Optional per-criterion result the agent may emit when a frozen task_plan
 * was attached to the run. `met=true` should carry an `evidence` string
 * (commit sha, file path, behavior); `met=false` should carry a `reason`.
 * Both are optional — the runner renders whatever the agent provides.
 */
export interface AcceptanceResult {
  criterion: string;
  met: boolean;
  evidence?: string;
  reason?: string;
}

export interface FactoryStatus {
  status: FactoryStatusKind;
  summary: string;
  questions: string[];
  /**
   * Per-criterion results. Optional even on plan-attached runs — null parse
   * does NOT fail the overall status block. Empty array when the agent did
   * not emit acceptance results at all.
   */
  acceptance: AcceptanceResult[];
}

const FENCE_RE = /```\s*factory-status\s*\n([\s\S]*?)```/i;

interface MaybeStatus {
  status?: unknown;
  summary?: unknown;
  questions?: unknown;
  acceptance?: unknown;
}

interface MaybeAcceptanceResult {
  criterion?: unknown;
  met?: unknown;
  evidence?: unknown;
  reason?: unknown;
}

function coerceAcceptance(raw: unknown): AcceptanceResult[] {
  if (!Array.isArray(raw)) return [];
  const out: AcceptanceResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as MaybeAcceptanceResult;
    const criterion = typeof r.criterion === "string" ? r.criterion.trim() : "";
    if (!criterion) continue;
    const met = r.met === true; // anything non-true is treated as not met
    const evidence = typeof r.evidence === "string" ? r.evidence.trim() : undefined;
    const reason = typeof r.reason === "string" ? r.reason.trim() : undefined;
    out.push({ criterion, met, evidence, reason });
  }
  return out;
}

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

function coerce(raw: unknown): FactoryStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as MaybeStatus;
  const status = typeof obj.status === "string" ? obj.status.toLowerCase().trim() : "";
  if (status !== "done" && status !== "blocked" && status !== "failed") return null;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const questions = Array.isArray(obj.questions)
    ? obj.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : [];
  const acceptance = coerceAcceptance(obj.acceptance);
  return { status: status as FactoryStatusKind, summary, questions, acceptance };
}

/**
 * Returns the parsed status block, or null if none could be found.
 * `null` is the caller's signal to treat the run as failed (we never default
 * to "done" — that's how false completions slip through).
 */
export function parseFactoryStatus(text: string): FactoryStatus | null {
  const fenced = FENCE_RE.exec(text);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      const out = coerce(parsed);
      if (out) return out;
    } catch {
      // fall through to balanced-brace scan
    }
  }

  // Some agents drop the fence or use a different language tag. Scan the last
  // 4KB for a balanced object that looks like our schema.
  const tail = text.length > 4096 ? text.slice(-4096) : text;
  let cursor = 0;
  let lastValid: FactoryStatus | null = null;
  while (cursor < tail.length) {
    const slice = findBalancedJsonObject(tail.slice(cursor));
    if (!slice) break;
    try {
      const parsed = JSON.parse(slice);
      const out = coerce(parsed);
      if (out) lastValid = out;
    } catch {
      // keep scanning
    }
    cursor += tail.indexOf(slice, cursor) + slice.length;
    if (cursor <= 0) break;
  }
  return lastValid;
}

const COMPLETION_FOOTER_BASE = `

---

# Factory completion protocol

You are running inside a sandboxed git worktree. When you finish — whether you
fully completed the task, hit a blocker, or determined it cannot be done —
end your response with a single fenced block of the form:

\`\`\`factory-status
{"status": "done" | "blocked" | "failed",
 "summary": "One to three sentences describing what you actually did, or what is missing.",
 "questions": ["Only if status is blocked: specific questions whose answers would unblock you."]}
\`\`\`

Rules:
- This is a non-interactive run. Do NOT wait for stdin or ask the operator
  questions in prose; if you need input, set status to "blocked" and put your
  questions in the array.
- Use status="done" only if you actually completed every acceptance
  criterion. **Partial completion → status="blocked"**, not "done with
  caveats." A "done with one item missing" hides the gap from auto-merge
  and lands incomplete work on main. The operator would rather see honest
  blocked status than a quietly-degraded done.
- If you determined the work cannot be done as specified, status="failed"
  with a summary explaining what's structurally in the way.
- Commit your work deliberately before emitting the final message. The
  daemon will fall back to auto-committing residual dirty state, but
  committed-with-message work is what review reads — auto-commit is a
  safety net, not your default.
`;

const DECISION_PROTOCOL_COLLABORATIVE = `

---

# Factory decision protocol — surfacing key decisions to the operator

This run executes against an operator who is not at the keyboard. You are
expected to make decisions and proceed; **most internal choices stay
internal**. But some choices are worth flagging *non-blockingly* so the
operator can ratify, override, or learn — without halting the run.

## When to surface a decision

Emit a \`factory-decision\` block ONLY when one of these is true:

(a) **Public surface.** The choice will be visible at the project's
    public surface — public API naming, CLAUDE.md doctrine, schema
    field names, file or directory structure others will read or
    import.

(b) **Reasonable disagreement.** Two or more competent engineers
    would disagree about the choice and the tradeoff is non-trivial.
    "Tabs vs. spaces" doesn't qualify; "compose vs. inherit", "library
    X vs. Y when both fit", "sync vs. async API" qualifies.

(c) **Future-constraining.** The choice meaningfully constrains future
    work — adopting a pattern others will follow, picking a dependency
    that's hard to swap later, naming a domain concept the codebase
    will repeat.

## When NOT to surface

Do not emit a decision block for:
- Internal implementation details (where a helper lives, local
  variable names, private function signatures)
- Style, formatting, lint, comment phrasing
- Test strategy when the project's existing tests / CLAUDE.md set the
  precedent
- Choices the operator would not have asked you to flag in advance

When in doubt, **do not surface**. The operator's attention is the
scarcest resource — verbose decision streams burn it faster than the
work itself.

## How to surface

Make a defensible choice and proceed — the run does not stop. Then,
emit a fenced block:

\`\`\`factory-decision
{
  "id": "dec-001",
  "kind": "architectural | library | naming | scope | tradeoff",
  "responseType": "single",
  "summary": "<one-line headline>",
  "context": "<2-4 sentences explaining why this is worth surfacing>",
  "options": [
    { "title": "Option A", "tradeoff": "<short>", "chosen": true },
    { "title": "Option B", "tradeoff": "<short>" }
  ],
  "decided": "Option A",
  "reasoning": "<one or two sentences on why you picked this>"
}
\`\`\`

- \`id\` is short and unique within this run (\`dec-001\`, \`dec-002\`).
  Reusing an id signals an update to the same decision; new ids signal
  new decisions.
- \`kind\` categorizes for the inbox card; pick the closest fit.

- \`responseType\` controls what the operator sees in the override form:
  - **\`single\`** (most common, default): \`options\` is a closed set
    of mutually-exclusive choices. You picked one (\`"chosen": true\`).
    Operator can ratify, override to a different option, or write a
    custom answer.
  - **\`multi\`**: \`options\` is a set where any subset is valid. You
    pick one or more (\`"chosen": true\` on each picked option). Use
    sparingly — most decisions are single-pick.
  - **\`free\`**: there are no canonical options; the question is
    open-ended. Omit \`options\` (or leave \`[]\`); set \`decided\` to
    your free-form answer. Operator can ratify or write a different
    answer.

- \`options\` lists 2–4 meaningfully-different choices with a one-line
  tradeoff each. Required for \`single\` and \`multi\`; omit for \`free\`.
  Chosen options carry \`"chosen": true\`.
- \`decided\` is the canonical "what I went with" — for \`single\` it's
  the chosen option's title; for \`multi\` it's a comma-separated list
  of chosen option titles; for \`free\` it's your free-form answer.
- Multiple decision blocks per run are allowed but rare. If you emit
  more than 3 in one run, the operator will think you're being
  indecisive. Be selective.
`;

const DECISION_PROTOCOL_AUTONOMOUS = `

---

# Factory decision protocol — autonomous mode

This project is configured for **autonomous** runs. Do NOT emit
\`factory-decision\` blocks. When you face an architectural / library /
naming choice that you would otherwise surface in collaborative mode,
pick the most defensible path and note your choice (one line) in the
factory-status \`summary\`. The operator reads the summary; if they
disagree they'll flip the project to collaborative mode and re-run, or
file a refinement task.
`;

function decisionFooterFor(autonomyMode: "collaborative" | "autonomous"): string {
  return autonomyMode === "autonomous"
    ? DECISION_PROTOCOL_AUTONOMOUS
    : DECISION_PROTOCOL_COLLABORATIVE;
}

export type AutonomyMode = "collaborative" | "autonomous";

/** Append the completion + decision protocols to the operator's task body. */
export function wrapPrompt(taskBody: string, autonomyMode: AutonomyMode = "collaborative"): string {
  return `${taskBody.trimEnd()}${COMPLETION_FOOTER_BASE}${decisionFooterFor(autonomyMode)}`;
}

interface FrozenTaskPlanForPrompt {
  goal: string;
  steps: Array<{ order: number; title: string; detail: string }>;
  acceptance: string[];
  touches: string[];
  risks: string[];
}

function renderPlanBlock(plan: FrozenTaskPlanForPrompt): string {
  const stepsBlock =
    plan.steps.length > 0
      ? plan.steps
          .map((s) => `${String(s.order).padStart(2, "0")}. ${s.title}\n    ${s.detail}`)
          .join("\n")
      : "(none recorded)";
  const acceptanceBlock =
    plan.acceptance.length > 0
      ? plan.acceptance.map((a) => `- ${a}`).join("\n")
      : "(none recorded)";
  const touchesBlock =
    plan.touches.length > 0
      ? plan.touches.map((t) => `- ${t}`).join("\n")
      : "(no specific paths called out)";
  const risksBlock =
    plan.risks.length > 0 ? plan.risks.map((r) => `- ${r}`).join("\n") : "(no risks called out)";

  return `

---

## Frozen plan (authoritative)

This plan was iterated on with the operator and frozen. Treat its scope as
binding — do not extend the work beyond what's listed. If a step proves
impossible or the plan is wrong, declare \`blocked\` in the factory-status
block with a question rather than improvising.

**Acceptance precedence:** if the frozen plan's acceptance list and the
task body's \`## Acceptance\` section disagree, the **frozen plan wins** —
it's what the operator approved. Treat the task body's acceptance as
context only when the plan has none recorded.

Goal: ${plan.goal || "(restated below in the task body)"}

Steps:
${stepsBlock}

Acceptance criteria (authoritative):
${acceptanceBlock}

Files expected to be touched:
${touchesBlock}

Risks called out:
${risksBlock}

When you emit factory-status, **populate \`acceptance\`** with one
\`{criterion, met, evidence?, reason?}\` entry per criterion above. The
runner cross-checks this list against your declared status — if any
\`met: false\` entry is present, status="done" is downgraded to
status="blocked" so the operator sees the gap. \`evidence\` should cite a
commit sha, file path, or observed behavior; \`reason\` should explain
what blocked an unmet criterion.
`;
}

/**
 * Wrap a task body with a frozen `task_plan` block before appending the
 * completion-protocol footer. Used by the runner when the run row's
 * `task_plan_id` resolves to a frozen plan: the agent reads the plan as
 * authoritative context alongside the raw task body.
 */
export function wrapPromptWithPlan(
  taskId: string,
  taskBody: string,
  plan: FrozenTaskPlanForPrompt,
  autonomyMode: AutonomyMode = "collaborative",
): string {
  const taskHeader = `You are working on task ${taskId}.\n\n## Task body\n\n`;
  return `${taskHeader}${taskBody.trim()}${renderPlanBlock(plan)}${COMPLETION_FOOTER_BASE}${decisionFooterFor(autonomyMode)}`;
}

const RESUME_PREFIX = `The factory daemon was restarted while you were working on this task. The previous Claude session has been resumed; you have full context of what you were doing. Pick up where you left off.

Before continuing:
- Run \`git status\` and \`git log --oneline -5\` to see what state the worktree is in.
- If your prior work fully satisfies the task, just declare done with a summary of what you delivered.
- If it's partial, finish the remaining work and then declare done.
- If you're stuck because of an unanswered question, declare blocked with the question.

For reference, the original task was:

`;

/**
 * Build the prompt for a resumed run. Used by the daemon-restart recovery
 * path: claude is invoked with `--resume <sessionId>`, and this string is
 * appended as the new user turn. The agent already has the full prior
 * conversation; we just nudge it to inspect state and finish.
 */
export function wrapResumePrompt(
  taskBody: string,
  autonomyMode: AutonomyMode = "collaborative",
): string {
  return `${RESUME_PREFIX}${taskBody.trimEnd()}${COMPLETION_FOOTER_BASE}${decisionFooterFor(autonomyMode)}`;
}

/**
 * Plan-aware variant: when a frozen task_plan was attached, re-include the
 * plan block so the resumed agent sees it even if the recovered session's
 * context is cold. The plan is the operator-approved scope contract — if
 * the resumed session lost it, the agent could improvise unbounded.
 */
export function wrapResumePromptWithPlan(
  taskBody: string,
  plan: FrozenTaskPlanForPrompt,
  autonomyMode: AutonomyMode = "collaborative",
): string {
  return `${RESUME_PREFIX}${taskBody.trimEnd()}${renderPlanBlock(plan)}${COMPLETION_FOOTER_BASE}${decisionFooterFor(autonomyMode)}`;
}
