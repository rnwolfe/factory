import { describe, expect, test } from "bun:test";
import { codexAgent } from "@factory/runtime";
import { parseFactoryStatus, wrapPrompt } from "../src/workers/factory-status.ts";

/**
 * Wire-level contract: the codex provider's `text` events must carry the
 * factory-status footer verbatim through the same accumulation path the
 * runner uses (`agentText += e.text`). Without this, a codex run that
 * declares `done` would be misclassified as `failed`, or a codex run
 * with no footer would not trigger the null-parse-fail backstop.
 *
 * Mirrors the loop in `apps/daemon/src/workers/runner.ts` where the
 * runner accumulates text events and then calls `parseFactoryStatus`
 * on the result.
 */
function accumulateAgentText(stream: object[]): string {
  let agentText = "";
  for (const line of stream) {
    const events = codexAgent.parseLine(JSON.stringify(line));
    for (const e of events) {
      if (e.kind === "text") agentText += e.text;
    }
  }
  return agentText;
}

describe("codex agent → factory-status contract", () => {
  test("run prompts forbid broad process-name cleanup that can kill the daemon", () => {
    const prompt = wrapPrompt("Smoke test the local server.");

    expect(prompt).toContain("Do NOT use broad process-name cleanup");
    expect(prompt).toContain("pkill -f");
    expect(prompt).toContain("server_pid=$!");
  });

  test("agent_message carrying a fenced factory-status block parses to done", () => {
    const footer = '```factory-status\n{"status": "done", "summary": "Landed the change."}\n```';
    const stream = [
      { type: "thread.started", thread_id: "th_abc" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: { type: "command_execution", command: "ls" },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", text: `Did the work.\n\n${footer}` },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
      },
    ];
    const text = accumulateAgentText(stream);
    const parsed = parseFactoryStatus(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe("done");
    expect(parsed?.summary).toContain("Landed");
  });

  test("agent_message reporting blocked propagates with questions", () => {
    const footer = `\`\`\`factory-status
{"status": "blocked", "summary": "Need the API key.", "questions": ["Where is the API key stored?"]}
\`\`\``;
    const stream = [
      { type: "thread.started", thread_id: "th_xyz" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: `Got stuck.\n${footer}` },
      },
      { type: "turn.completed", usage: {} },
    ];
    const parsed = parseFactoryStatus(accumulateAgentText(stream));
    expect(parsed?.status).toBe("blocked");
    expect(parsed?.questions).toContain("Where is the API key stored?");
  });

  test("no fenced block in any agent_message → parseFactoryStatus returns null", () => {
    // Null-parse-fail discipline: a codex run that does NOT emit a footer
    // must not be silently mapped to "completed". `runStatusFor(null, false)`
    // in runner.ts maps this to `failed`. This test pins the upstream half
    // of that contract — the parser sees null when codex omits the block.
    const stream = [
      { type: "thread.started", thread_id: "th_no_footer" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: { type: "command_execution", command: "echo done" },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "All done. I made the changes you asked for. Cheers!",
        },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ];
    const parsed = parseFactoryStatus(accumulateAgentText(stream));
    expect(parsed).toBeNull();
  });

  test("footer split across multiple agent_message events still parses", () => {
    // Codex sometimes emits multiple agent_message items in one turn. The
    // runner accumulates them all, so a footer that straddles a boundary
    // must still parse — pin this so a future refactor doesn't reintroduce
    // a per-message parse.
    const stream = [
      { type: "thread.started", thread_id: "th_split" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Doing the work...\n\n```factory-status\n" },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: '{"status": "done", "summary": "Multi-message footer."}\n```\n',
        },
      },
      { type: "turn.completed", usage: {} },
    ];
    const parsed = parseFactoryStatus(accumulateAgentText(stream));
    expect(parsed?.status).toBe("done");
    expect(parsed?.summary).toBe("Multi-message footer.");
  });
});
