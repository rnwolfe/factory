import { describe, expect, test } from "bun:test";
import { claudeCodeAgent, parseUsageResetTime } from "../../src/agents/claude-code.ts";

describe("claudeCodeAgent.buildArgv", () => {
  test("base invocation uses --print, stream-json, --verbose, --dangerously-skip-permissions", () => {
    const r = claudeCodeAgent.buildArgv("hello", {});
    expect(r.argv).toEqual([
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
    expect(r.stdin).toBe("hello");
  });

  test("includes --resume when sessionId provided", () => {
    const r = claudeCodeAgent.buildArgv("p", { resumeSessionId: "abc-123" });
    expect(r.argv).toContain("--resume");
    expect(r.argv).toContain("abc-123");
  });

  test("includes --model when set", () => {
    const r = claudeCodeAgent.buildArgv("p", { model: "claude-opus-4-7" });
    expect(r.argv).toContain("--model");
    expect(r.argv).toContain("claude-opus-4-7");
  });
});

describe("claudeCodeAgent.parseLine", () => {
  test("ignores empty / non-JSON lines", () => {
    expect(claudeCodeAgent.parseLine("")).toEqual([]);
    expect(claudeCodeAgent.parseLine("   ")).toEqual([]);
    expect(claudeCodeAgent.parseLine("not json")).toEqual([]);
    expect(claudeCodeAgent.parseLine("{not")).toEqual([]);
  });

  test("emits session event from system init line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess_abc",
      cwd: "/tmp",
    });
    const events = claudeCodeAgent.parseLine(line);
    expect(events).toContainEqual({ kind: "session", id: "sess_abc" });
  });

  test("emits text event from assistant text content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello world" },
          { type: "text", text: "second" },
        ],
      },
    });
    const events = claudeCodeAgent.parseLine(line);
    expect(events).toEqual([
      { kind: "text", text: "hello world" },
      { kind: "text", text: "second" },
    ]);
  });

  test("emits tool event from tool_use content with cheap arg summary", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "ls -la /etc" },
          },
        ],
      },
    });
    const events = claudeCodeAgent.parseLine(line);
    expect(events).toEqual([{ kind: "tool", name: "Bash", argSummary: "ls -la /etc" }]);
  });

  test("tool summary truncates and falls back to JSON when no primary field", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Custom",
            input: { weird: "x".repeat(120) },
          },
        ],
      },
    });
    const [evt] = claudeCodeAgent.parseLine(line);
    expect(evt?.kind).toBe("tool");
    if (evt && evt.kind === "tool") {
      expect(evt.argSummary.length).toBeLessThanOrEqual(80);
    }
  });

  test("emits text + agent_exit on result line", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "final answer",
      session_id: "sess_xyz",
    });
    const events = claudeCodeAgent.parseLine(line);
    expect(events.find((e) => e.kind === "text")).toEqual({
      kind: "text",
      text: "final answer",
    });
    const exit = events.find((e) => e.kind === "agent_exit");
    expect(exit).toBeDefined();
    if (exit && exit.kind === "agent_exit") {
      expect(exit.exitCode).toBe(0);
    }
    expect(events.find((e) => e.kind === "session")).toEqual({
      kind: "session",
      id: "sess_xyz",
    });
  });

  test("agent_exit reflects is_error=true", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
    });
    const exit = claudeCodeAgent.parseLine(line).find((e) => e.kind === "agent_exit");
    if (exit && exit.kind === "agent_exit") {
      expect(exit.exitCode).toBe(1);
    } else {
      throw new Error("expected agent_exit");
    }
  });

  test("ignores unknown content types within assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", text: "internal" },
          { type: "text", text: "external" },
        ],
      },
    });
    const events = claudeCodeAgent.parseLine(line);
    expect(events).toEqual([{ kind: "text", text: "external" }]);
  });
});

describe("claudeCodeAgent.detectStaleness", () => {
  test("matches Claude resume prompt", () => {
    expect(claudeCodeAgent.detectStaleness?.("Resume conversation? (y/N)")).toBe(true);
    expect(
      claudeCodeAgent.detectStaleness?.("Some preamble. Resume conversation? (y/N) trailing"),
    ).toBe(true);
  });

  test("matches session expiry / re-auth prompts", () => {
    expect(claudeCodeAgent.detectStaleness?.("Your session has expired.")).toBe(true);
    expect(claudeCodeAgent.detectStaleness?.("Please log in again to continue")).toBe(true);
    expect(claudeCodeAgent.detectStaleness?.("Authentication failed for token")).toBe(true);
  });

  test("does not flag routine output", () => {
    expect(claudeCodeAgent.detectStaleness?.("hello world")).toBe(false);
    expect(claudeCodeAgent.detectStaleness?.('{"type":"text"}')).toBe(false);
    expect(claudeCodeAgent.detectStaleness?.("")).toBe(false);
  });
});

describe("parseUsageResetTime", () => {
  test("parses a 12-hour am reset into a future timestamp", () => {
    const at = parseUsageResetTime("You've hit your limit · resets 12:10am (America/New_York)");
    expect(at).not.toBeNull();
    if (at == null) throw new Error("expected a timestamp");
    expect(at).toBeGreaterThan(Date.now());
    const d = new Date(at);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(10);
  });

  test("parses a 12-hour pm reset", () => {
    const at = parseUsageResetTime("resets 3:30pm");
    if (at == null) throw new Error("expected a timestamp");
    const d = new Date(at);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(30);
  });

  test("maps 12pm to noon and 12am to midnight", () => {
    const noon = parseUsageResetTime("resets 12:00pm");
    const mid = parseUsageResetTime("resets 12:00am");
    if (noon == null || mid == null) throw new Error("expected timestamps");
    expect(new Date(noon).getHours()).toBe(12);
    expect(new Date(mid).getHours()).toBe(0);
  });

  test("returns null when no reset time is present", () => {
    expect(parseUsageResetTime("You've hit your limit")).toBeNull();
    expect(parseUsageResetTime("nothing here")).toBeNull();
    expect(parseUsageResetTime("resets soon")).toBeNull();
  });
});

describe("claudeCodeAgent usage-cap detection", () => {
  test("emits usage_limit on an is_error result that names the cap", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "You've hit your limit · resets 12:10am (America/New_York)",
      session_id: "sess_cap",
    });
    const events = claudeCodeAgent.parseLine(line);
    const cap = events.find((e) => e.kind === "usage_limit");
    expect(cap).toBeDefined();
    if (cap && cap.kind === "usage_limit") {
      expect(cap.message).toContain("hit your limit");
      expect(cap.resetsAt).not.toBeNull();
    }
    // agent_exit still fires alongside it — the runner sees both.
    expect(events.some((e) => e.kind === "agent_exit")).toBe(true);
  });

  test("no usage_limit on a successful result", () => {
    const line = JSON.stringify({ type: "result", is_error: false, result: "all done" });
    expect(claudeCodeAgent.parseLine(line).some((e) => e.kind === "usage_limit")).toBe(false);
  });

  test("no usage_limit on an unrelated error result", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Something else went wrong",
    });
    expect(claudeCodeAgent.parseLine(line).some((e) => e.kind === "usage_limit")).toBe(false);
  });
});
