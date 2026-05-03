import type { AgentSpec, StreamEvent } from "../types.ts";

const STALENESS_PATTERNS = [
  /Resume conversation\? \(y\/N\)/i,
  /Your session has expired/i,
  /Please log in again/i,
  /Authentication failed/i,
  /Run `claude login` to authenticate/i,
];

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
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 80);
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
  if (typeof primary === "string") return primary.slice(0, 80);
  try {
    return JSON.stringify(obj).slice(0, 80);
  } catch {
    return "";
  }
}

export const claudeCodeAgent: AgentSpec = {
  name: "claude-code",

  buildArgv(prompt, opts) {
    const argv: string[] = ["claude", "--print", "--output-format", "stream-json", "--verbose"];
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
            argSummary: summarizeToolInput(c.input),
          });
        }
      }
    }

    if (parsed.type === "result") {
      // Surface the final assistant text once if present (some flows skip the
      // assistant turn and only deliver text via the result envelope).
      if (typeof parsed.result === "string" && parsed.result.length > 0) {
        events.push({ kind: "text", text: parsed.result });
      }
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
