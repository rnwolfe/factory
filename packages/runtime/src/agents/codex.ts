import type { AgentMetrics, AgentSpec, StreamEvent } from "../types.ts";

const STALENESS_PATTERNS = [
  /Authentication required/i,
  /Please log in/i,
  /Unauthorized/i,
  /codex login/i,
  /session expired/i,
];

/**
 * Matches rate-limit or quota exhaustion messages from the codex CLI. The CLI
 * doesn't emit a structured cap event, so we detect it from agent_message text.
 */
const USAGE_LIMIT_RE = /rate.?limit|usage.?limit|quota.?exceeded|too many requests/i;

interface CodexStreamLine {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

export const codexAgent: AgentSpec = {
  name: "codex",

  buildArgv(prompt, opts) {
    // --dangerously-bypass-approvals-and-sandbox: codex's equivalent of
    // claude's --dangerously-skip-permissions. Non-interactive daemon runs
    // have no human to approve tool calls; isolation comes from the per-run
    // worktree. See docs/adr/006-codex-harness.md.
    const argv: string[] = [
      "codex",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    if (opts.model) {
      argv.push("--model", opts.model);
    }
    // codex exec has no --resume equivalent; resumeSessionId is intentionally ignored.
    return { argv, stdin: prompt };
  },

  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];

    let parsed: CodexStreamLine;
    try {
      parsed = JSON.parse(trimmed) as CodexStreamLine;
    } catch {
      return [];
    }

    const events: StreamEvent[] = [];

    // thread.started carries the session ID (codex calls it thread_id).
    if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
      events.push({ kind: "session", id: parsed.thread_id });
    }

    // item.started fires when the model dispatches a tool call (shell command).
    if (parsed.type === "item.started") {
      const item = parsed.item;
      if (item?.type === "command_execution" && typeof item.command === "string") {
        events.push({
          kind: "tool",
          name: "shell",
          argSummary: item.command.slice(0, 80),
        });
      }
    }

    // item.completed carries the agent's final text or a completed tool call.
    if (parsed.type === "item.completed") {
      const item = parsed.item;
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.length > 0) {
        events.push({ kind: "text", text: item.text });
        if (USAGE_LIMIT_RE.test(item.text)) {
          events.push({
            kind: "usage_limit",
            resetsAt: null,
            message: item.text.trim(),
          });
        }
      }
    }

    // turn.completed signals the agent is done for this invocation.
    if (parsed.type === "turn.completed") {
      const usage = parsed.usage ?? {};
      const metrics: AgentMetrics = {
        totalCostUsd: 0, // codex does not report per-call cost
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 1,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationTokens: 0,
        cacheReadTokens: usage.cached_input_tokens ?? 0,
        model: null,
        modelUsage: {},
        isError: false,
        subtype: null,
        sessionId: null,
      };
      events.push({ kind: "metrics", metrics });
      events.push({ kind: "agent_exit", exitCode: 0, ts: Date.now() });
    }

    return events;
  },

  detectStaleness(line) {
    return STALENESS_PATTERNS.some((re) => re.test(line));
  },
};
