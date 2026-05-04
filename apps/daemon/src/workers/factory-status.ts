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

const COMPLETION_FOOTER = `

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
- Use status="done" only if you actually completed the task's acceptance
  criteria. If you only made partial progress, use "blocked" or "failed" with
  an honest summary.
- Save and (if you can) commit your work before emitting the final message —
  the daemon will auto-commit any residual dirty state, but committed work is
  cleaner to review.
`;

/** Append the completion-protocol instructions to the operator's task body. */
export function wrapPrompt(taskBody: string): string {
  return `${taskBody.trimEnd()}${COMPLETION_FOOTER}`;
}

interface FrozenTaskPlanForPrompt {
  goal: string;
  steps: Array<{ order: number; title: string; detail: string }>;
  acceptance: string[];
  touches: string[];
  risks: string[];
}

/**
 * Wrap a task body with a frozen `task_plan` block before appending the
 * completion-protocol footer. Used by the runner when the run row's
 * `task_plan_id` resolves to a frozen plan: the agent reads the plan as
 * authoritative context alongside the raw task body.
 *
 * The plan section is fenced with explicit "do not deviate" framing so the
 * agent treats it as binding rather than advisory. Empty arrays are dropped
 * to keep the prompt tight.
 */
export function wrapPromptWithPlan(
  taskId: string,
  taskBody: string,
  plan: FrozenTaskPlanForPrompt,
): string {
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

  const planBlock = `

---

## Frozen plan (authoritative)

This plan was iterated on with the operator and frozen. Treat its scope as
binding — do not extend the work beyond what's listed. If a step proves
impossible or the plan is wrong, declare \`blocked\` in the factory-status
block with a question rather than improvising.

Goal: ${plan.goal || "(restated below in the task body)"}

Steps:
${stepsBlock}

Acceptance criteria:
${acceptanceBlock}

Files expected to be touched:
${touchesBlock}

Risks called out:
${risksBlock}

If the factory-status block supports it, set \`acceptance\` to a list of
\`{criterion, met, evidence?, reason?}\` objects so the operator can see
which acceptance items the run actually satisfied.
`;

  const taskHeader = `You are working on task ${taskId}.\n\n## Task body\n\n`;
  return `${taskHeader}${taskBody.trim()}${planBlock}${COMPLETION_FOOTER}`;
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
export function wrapResumePrompt(taskBody: string): string {
  return `${RESUME_PREFIX}${taskBody.trimEnd()}${COMPLETION_FOOTER}`;
}
