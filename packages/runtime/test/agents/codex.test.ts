import { describe, expect, test } from "bun:test";
import { codexAgent } from "../../src/agents/codex.ts";

describe("codexAgent.buildArgv", () => {
  test("base invocation uses exec --json --dangerously-bypass-approvals-and-sandbox", () => {
    const r = codexAgent.buildArgv("hello", {});
    expect(r.argv).toEqual([
      "codex",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(r.stdin).toBe("hello");
  });

  test("includes --model when set", () => {
    const r = codexAgent.buildArgv("p", { model: "codex-1" });
    expect(r.argv).toContain("--model");
    expect(r.argv).toContain("codex-1");
  });

  test("omits --model when null/undefined (provider default)", () => {
    const r = codexAgent.buildArgv("p", {});
    expect(r.argv).not.toContain("--model");
  });

  test("ignores resumeSessionId — codex exec has no --resume equivalent", () => {
    // ADR-006: codex has no per-invocation resume. The runner may pass a
    // sessionId from a prior cap-resume attempt; the provider drops it
    // silently rather than fabricating a flag the CLI would reject.
    const r = codexAgent.buildArgv("p", { resumeSessionId: "thread-abc" });
    expect(r.argv).not.toContain("--resume");
    expect(r.argv).not.toContain("thread-abc");
  });
});

describe("codexAgent.parseLine", () => {
  test("ignores empty / non-JSON / non-object lines", () => {
    expect(codexAgent.parseLine("")).toEqual([]);
    expect(codexAgent.parseLine("   ")).toEqual([]);
    expect(codexAgent.parseLine("not json")).toEqual([]);
    expect(codexAgent.parseLine("{not")).toEqual([]);
    expect(codexAgent.parseLine("[1,2]")).toEqual([]);
  });

  test("emits session event from thread.started line", () => {
    const line = JSON.stringify({
      type: "thread.started",
      thread_id: "019e603f-0fc8-7d42-a0d3-264f495beb02",
    });
    const events = codexAgent.parseLine(line);
    expect(events).toContainEqual({
      kind: "session",
      id: "019e603f-0fc8-7d42-a0d3-264f495beb02",
    });
  });

  test("emits tool event from item.started command_execution", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "ls -la /etc" },
    });
    const events = codexAgent.parseLine(line);
    expect(events).toEqual([{ kind: "tool", name: "shell", argSummary: "ls -la /etc" }]);
  });

  test("tool argSummary truncates long commands", () => {
    const long = "echo ".concat("x".repeat(120));
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: long },
    });
    const [evt] = codexAgent.parseLine(line);
    expect(evt?.kind).toBe("tool");
    if (evt && evt.kind === "tool") {
      expect(evt.argSummary.length).toBeLessThanOrEqual(80);
    }
  });

  test("emits text event from item.completed agent_message", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hello world" },
    });
    const events = codexAgent.parseLine(line);
    expect(events).toContainEqual({ kind: "text", text: "hello world" });
  });

  test("emits metrics + agent_exit on turn.completed", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 50,
      },
    });
    const events = codexAgent.parseLine(line);
    const metrics = events.find((e) => e.kind === "metrics");
    expect(metrics).toBeDefined();
    if (metrics && metrics.kind === "metrics") {
      expect(metrics.metrics.inputTokens).toBe(100);
      expect(metrics.metrics.outputTokens).toBe(50);
      expect(metrics.metrics.cacheReadTokens).toBe(10);
      // Codex does not report per-call cost.
      expect(metrics.metrics.totalCostUsd).toBe(0);
    }
    const exit = events.find((e) => e.kind === "agent_exit");
    expect(exit).toBeDefined();
    if (exit && exit.kind === "agent_exit") {
      expect(exit.exitCode).toBe(0);
    }
  });

  test("emits usage_limit when agent_message reports rate/usage cap", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Sorry — you've hit the rate limit for this account.",
      },
    });
    const events = codexAgent.parseLine(line);
    const cap = events.find((e) => e.kind === "usage_limit");
    expect(cap).toBeDefined();
    if (cap && cap.kind === "usage_limit") {
      // ADR-006: codex emits no structured reset time; null is expected.
      expect(cap.resetsAt).toBeNull();
      expect(cap.message).toContain("rate limit");
    }
  });

  test("does not emit usage_limit on routine agent text", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "All done; PR opened." },
    });
    const events = codexAgent.parseLine(line);
    expect(events.some((e) => e.kind === "usage_limit")).toBe(false);
  });

  test("ignores item.completed agent_message with empty text", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "" },
    });
    const events = codexAgent.parseLine(line);
    expect(events.some((e) => e.kind === "text")).toBe(false);
  });
});

describe("codexAgent.detectStaleness", () => {
  test("matches the re-auth / session-expired prompts", () => {
    expect(codexAgent.detectStaleness?.("Authentication required to continue")).toBe(true);
    expect(codexAgent.detectStaleness?.("Please log in to use this feature")).toBe(true);
    expect(codexAgent.detectStaleness?.("Unauthorized: 401")).toBe(true);
    expect(codexAgent.detectStaleness?.("Run `codex login` to authenticate")).toBe(true);
    expect(codexAgent.detectStaleness?.("session expired")).toBe(true);
  });

  test("does not flag routine output", () => {
    expect(codexAgent.detectStaleness?.("hello world")).toBe(false);
    expect(codexAgent.detectStaleness?.('{"type":"text"}')).toBe(false);
    expect(codexAgent.detectStaleness?.("")).toBe(false);
  });
});

describe("codex factory-status footer compatibility", () => {
  // The factory-status contract is agent-independent: it scans the
  // accumulated `text` events the agent emits. Confirm that a codex run
  // emitting a factory-status footer in its agent_message produces a
  // text event the daemon can pass through to parseFactoryStatus, and
  // that the null-parse-fail discipline holds when the footer is absent.
  //
  // The actual parser lives in apps/daemon/src/workers/factory-status.ts
  // and is unit-tested there; this test just confirms the agent's
  // `text` events carry the footer bytes verbatim.
  test("agent_message text carries a factory-status fenced block verbatim", () => {
    const footer =
      '```factory-status\n{"status": "done", "summary": "Landed."}\n```';
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: `Did the work.\n\n${footer}` },
    });
    const events = codexAgent.parseLine(line);
    const text = events.find((e) => e.kind === "text");
    expect(text).toBeDefined();
    if (text && text.kind === "text") {
      expect(text.text).toContain("```factory-status");
      expect(text.text).toContain('"status": "done"');
    }
  });
});
