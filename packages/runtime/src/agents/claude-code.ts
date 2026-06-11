import type { AgentMetrics, AgentModelUsage, AgentSpec, StreamEvent } from "../types.ts";

const STALENESS_PATTERNS = [
  /Resume conversation\? \(y\/N\)/i,
  /Your session has expired/i,
  /Please log in again/i,
  /Authentication failed/i,
  /Run `claude login` to authenticate/i,
];

/**
 * Matches the CLI's result text when the account has hit its usage cap.
 * The qualifier is optional because the CLI uses both "hit your limit" and
 * "hit your <session|usage|weekly|…> limit" depending on which cap tripped —
 * missing the qualifier strands the run as `failed` with no auto-resume.
 */
const USAGE_LIMIT_RE = /hit your(?: \w+)? limit|usage limit|rate limit/i;

/**
 * Extract the cap reset time from a usage-limit message, e.g.
 * "You've hit your limit · resets 12:10am (America/New_York)" or the
 * minutes-less form "resets 1am" the CLI emits on round-hour resets.
 * Returns the next epoch-ms occurrence of that wall-clock time, or null
 * if absent.
 *
 * The CLI reports the operator's local timezone, which is the daemon host's
 * timezone too, so plain `Date` arithmetic resolves it correctly — the
 * parenthetical IANA name is informational and deliberately ignored.
 */
export function parseUsageResetTime(message: string): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(message);
  if (!m) return null;
  const [, hStr, mStr, ap] = m;
  if (!hStr || !ap) return null;
  let hour = Number(hStr);
  const minute = mStr ? Number(mStr) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (ap.toLowerCase() === "am") {
    hour = hour === 12 ? 0 : hour;
  } else {
    hour = hour === 12 ? 12 : hour + 12;
  }
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  // Parsed at cap time, so the reset is in the future; roll to tomorrow only
  // when HH:MM has already passed today.
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeModelUsage {
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  message?: {
    content?: Array<
      | { type: "text"; text?: string }
      | { type: "tool_use"; name?: string; input?: unknown }
      | { type: "tool_result" }
    >;
  };
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function buildMetrics(parsed: ClaudeStreamLine): AgentMetrics {
  const usage = parsed.usage ?? {};
  const modelUsage: Record<string, AgentModelUsage> = {};
  let primaryModel: string | null = null;
  if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
    for (const [name, mu] of Object.entries(parsed.modelUsage)) {
      modelUsage[name] = {
        costUSD: num(mu.costUSD),
        inputTokens: num(mu.inputTokens),
        outputTokens: num(mu.outputTokens),
        cacheReadInputTokens: num(mu.cacheReadInputTokens),
        cacheCreationInputTokens: num(mu.cacheCreationInputTokens),
      };
      if (!primaryModel) primaryModel = name;
    }
  }
  return {
    totalCostUsd: num(parsed.total_cost_usd),
    durationMs: num(parsed.duration_ms),
    durationApiMs: num(parsed.duration_api_ms),
    numTurns: num(parsed.num_turns),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    model: primaryModel,
    modelUsage,
    isError: parsed.is_error === true,
    subtype: typeof parsed.subtype === "string" ? parsed.subtype : null,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
  };
}

function relativize(str: string, worktreeRoot?: string): string {
  if (worktreeRoot) {
    const prefix = worktreeRoot.endsWith("/") ? worktreeRoot : `${worktreeRoot}/`;
    if (str.startsWith(prefix)) return str.slice(prefix.length).slice(0, 80);
  }
  return str.slice(0, 80);
}

function summarizeToolInput(input: unknown, worktreeRoot?: string): string {
  if (input == null) return "";
  if (typeof input === "string") return relativize(input, worktreeRoot);
  if (typeof input !== "object") return String(input).slice(0, 80);
  const obj = input as Record<string, unknown>;
  // Cheap heuristic: pick a likely "primary" field, else stringify.
  const primary =
    obj.command ??
    obj.file_path ??
    obj.path ??
    obj.url ??
    obj.pattern ??
    obj.query ??
    obj.description;
  if (typeof primary === "string") return relativize(primary, worktreeRoot);
  try {
    return JSON.stringify(obj).slice(0, 80);
  } catch {
    return "";
  }
}

export function createClaudeCodeAgent(worktreeRoot?: string): AgentSpec {
  return {
    name: "claude-code",

    buildArgv(prompt, opts) {
      // --dangerously-skip-permissions: code-changing runs are non-interactive, so
      // there is no human to approve Write/Edit/Bash prompts. The factory's
      // isolation comes from the per-run worktree, not from CLI permission
      // gates. Real sandboxing arrives with a container provider; until then this
      // is the supported way to keep runs unblocked. See docs/vision.md §5.
      const argv: string[] = [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (opts.resumeSessionId) {
        argv.push("--resume", opts.resumeSessionId);
      }
      if (opts.model) {
        argv.push("--model", opts.model);
      }
      return { argv, stdin: prompt };
    },

    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let parsed: ClaudeStreamLine;
      try {
        parsed = JSON.parse(trimmed) as ClaudeStreamLine;
      } catch {
        return [];
      }

      const events: StreamEvent[] = [];

      if (parsed.type === "system" && parsed.session_id) {
        events.push({ kind: "session", id: parsed.session_id });
      }

      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const c of parsed.message.content) {
          if (c.type === "text" && typeof c.text === "string" && c.text.length > 0) {
            events.push({ kind: "text", text: c.text });
          } else if (c.type === "tool_use") {
            events.push({
              kind: "tool",
              name: typeof c.name === "string" ? c.name : "tool",
              argSummary: summarizeToolInput(c.input, worktreeRoot),
            });
          }
        }
      }

      if (parsed.type === "result") {
        // Surface the final assistant text once if present (some flows skip the
        // assistant turn and only delivers text via the result envelope).
        if (typeof parsed.result === "string" && parsed.result.length > 0) {
          events.push({ kind: "text", text: parsed.result });
          // A usage-cap exit is an external quota stop, not a failure — surface
          // it as a distinct signal so the runner can resume rather than fail.
          if (parsed.is_error === true && USAGE_LIMIT_RE.test(parsed.result)) {
            events.push({
              kind: "usage_limit",
              resetsAt: parseUsageResetTime(parsed.result),
              message: parsed.result.trim(),
            });
          }
        }
        events.push({ kind: "metrics", metrics: buildMetrics(parsed) });
        events.push({
          kind: "agent_exit",
          exitCode: parsed.is_error ? 1 : 0,
          ts: Date.now(),
        });
        if (parsed.session_id) {
          events.push({ kind: "session", id: parsed.session_id });
        }
      }

      return events;
    },

    detectStaleness(line) {
      return STALENESS_PATTERNS.some((re) => re.test(line));
    },
  };
}

export const claudeCodeAgent: AgentSpec = createClaudeCodeAgent();
