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

export interface FactoryStatus {
  status: FactoryStatusKind;
  summary: string;
  questions: string[];
}

const FENCE_RE = /```\s*factory-status\s*\n([\s\S]*?)```/i;

interface MaybeStatus {
  status?: unknown;
  summary?: unknown;
  questions?: unknown;
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
  return { status: status as FactoryStatusKind, summary, questions };
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
