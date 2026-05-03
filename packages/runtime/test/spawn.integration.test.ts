import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as bunSpawn } from "bun";
import { runtime } from "../src/runtime.ts";
import { hostSandbox } from "../src/sandboxes/host.ts";
import type { AgentSpec, RuntimeEvent, StreamEvent } from "../src/types.ts";

/**
 * Stub agent: shells out to `printf` to produce a deterministic stream of
 * Claude-shaped JSONL on stdout. Lets us prove the spawn pipeline (tmux +
 * pipe-pane + tail + parser + onEvent) works without depending on the live
 * Claude CLI or auth.
 */
function makeStubAgent(): AgentSpec {
  return {
    name: "stub-claude",
    buildArgv(prompt) {
      const lines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "stub_session" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: `echoing: ${prompt}` }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          session_id: "stub_session",
        }),
      ];
      const argv = ["printf", `${lines.join("\\n")}\\n`];
      return { argv };
    },
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        const j = JSON.parse(trimmed);
        const events: StreamEvent[] = [];
        if (j.type === "system" && j.session_id) events.push({ kind: "session", id: j.session_id });
        if (j.type === "assistant" && j.message?.content) {
          for (const c of j.message.content) {
            if (c.type === "text") events.push({ kind: "text", text: c.text });
          }
        }
        if (j.type === "result") {
          events.push({ kind: "agent_exit", exitCode: j.is_error ? 1 : 0, ts: Date.now() });
          if (j.session_id) events.push({ kind: "session", id: j.session_id });
        }
        return events;
      } catch {
        return [];
      }
    },
  };
}

async function gitInitProject(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-runtime-test-"));
  await bunSpawn({ cmd: ["git", "init", "-q", "-b", "main"], cwd: root }).exited;
  await bunSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: root }).exited;
  await bunSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: root }).exited;
  writeFileSync(path.join(root, "README.md"), "# test\n");
  await bunSpawn({ cmd: ["git", "add", "-A"], cwd: root }).exited;
  await bunSpawn({ cmd: ["git", "commit", "-q", "-m", "init"], cwd: root }).exited;
  return root;
}

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("runtime.spawn (host sandbox)", () => {
  test("captures stream events end-to-end through tmux", async () => {
    const project = await gitInitProject();
    cleanup.push(project);
    const events: RuntimeEvent[] = [];
    const ac = new AbortController();

    const result = await runtime.spawn({
      runId: `t${Math.random().toString(36).slice(2, 10)}`,
      projectPath: project,
      task: { id: "stub-task", prompt: "hi there" },
      agent: makeStubAgent(),
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: 30,
      maxIterations: 1,
      abort: ac.signal,
      onEvent: (e) => events.push(e),
    });

    const texts = events.filter((e) => e.kind === "text");
    expect(texts.some((e) => e.kind === "text" && e.text.includes("echoing: hi there"))).toBe(true);
    const sessions = events.filter((e) => e.kind === "session");
    expect(sessions.some((e) => e.kind === "session" && e.id === "stub_session")).toBe(true);
    const exits = events.filter((e) => e.kind === "agent_exit");
    expect(exits.length).toBeGreaterThan(0);
    expect(result.sessionId).toBe("stub_session");
    expect(result.iterationsCompleted).toBe(1);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("two concurrent spawns to different projects do not interfere", async () => {
    const [pA, pB] = await Promise.all([gitInitProject(), gitInitProject()]);
    cleanup.push(pA, pB);
    const acA = new AbortController();
    const acB = new AbortController();
    const evA: RuntimeEvent[] = [];
    const evB: RuntimeEvent[] = [];

    const [resA, resB] = await Promise.all([
      runtime.spawn({
        runId: `a${Math.random().toString(36).slice(2, 8)}`,
        projectPath: pA,
        task: { id: "stub-a", prompt: "alpha" },
        agent: makeStubAgent(),
        sandbox: hostSandbox,
        strategy: { type: "head" },
        budgetSeconds: 30,
        maxIterations: 1,
        abort: acA.signal,
        onEvent: (e) => evA.push(e),
      }),
      runtime.spawn({
        runId: `b${Math.random().toString(36).slice(2, 8)}`,
        projectPath: pB,
        task: { id: "stub-b", prompt: "beta" },
        agent: makeStubAgent(),
        sandbox: hostSandbox,
        strategy: { type: "head" },
        budgetSeconds: 30,
        maxIterations: 1,
        abort: acB.signal,
        onEvent: (e) => evB.push(e),
      }),
    ]);

    expect(resA.runId).not.toBe(resB.runId);
    expect(evA.some((e) => e.kind === "text" && e.text.includes("alpha"))).toBe(true);
    expect(evB.some((e) => e.kind === "text" && e.text.includes("beta"))).toBe(true);
    // Cross-contamination check.
    expect(evA.some((e) => e.kind === "text" && e.text.includes("beta"))).toBe(false);
    expect(evB.some((e) => e.kind === "text" && e.text.includes("alpha"))).toBe(false);
  }, 60_000);

  test("AbortSignal kills the agent and tears down tmux within 5 seconds", async () => {
    const project = await gitInitProject();
    cleanup.push(project);
    const ac = new AbortController();

    const slowAgent: AgentSpec = {
      name: "slow",
      buildArgv() {
        // sleep long enough to be killable — much longer than the 5s budget.
        return { argv: ["sleep", "60"] };
      },
      parseLine() {
        return [];
      },
    };

    const start = Date.now();
    setTimeout(() => ac.abort(), 500);
    const result = await runtime.spawn({
      runId: `k${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      task: { id: "kill-test", prompt: "" },
      agent: slowAgent,
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: 30,
      maxIterations: 1,
      abort: ac.signal,
      onEvent: () => {},
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(result.exitCode).not.toBe(0);
  }, 15_000);
});
