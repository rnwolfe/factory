import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as bunSpawn, spawnSync as bunSpawnSync } from "bun";
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

// Isolate this suite's tmux onto a private server. `runtime.spawn` (via the
// real host sandbox) creates and tears down REAL tmux sessions; that churn on a
// SHARED default tmux server destabilizes it and kills co-tenant panes —
// including the parent `claude --print` pane when this suite runs inside a
// Factory self-hosting run (`bun run test`), which then dies before emitting a
// factory-status footer (the "wide bun test kills the run" bug). Setting
// FACTORY_TMUX_SOCKET makes every tmux command the runtime issues pass
// `-L <socket>` (see tmuxSocketArgs), landing on a throwaway server. This
// mirrors the daemon's orchestrate integration suites — this file was the one
// real-tmux suite the original fix missed. It must be a CLI flag, not an env
// tweak: Bun snapshots a child's env at spawn, so mutating $TMUX / TMUX_TMPDIR
// here would NOT reach the spawned tmux process.
const tmuxSocket = `factory-runtime-test-${process.pid}`;
let prevTmuxSocket: string | undefined;
beforeAll(() => {
  prevTmuxSocket = process.env.FACTORY_TMUX_SOCKET;
  process.env.FACTORY_TMUX_SOCKET = tmuxSocket;
});

const cleanup: string[] = [];
afterAll(() => {
  try {
    // Tear down this suite's private tmux server by its explicit socket —
    // never touches a shared/default server.
    bunSpawnSync({
      cmd: ["tmux", "-L", tmuxSocket, "kill-server"],
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // ignore — server may already be gone
  }
  if (prevTmuxSocket === undefined) delete process.env.FACTORY_TMUX_SOCKET;
  else process.env.FACTORY_TMUX_SOCKET = prevTmuxSocket;
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

  test("force-closes tmux when the agent lingers past its result envelope", async () => {
    const project = await gitInitProject();
    cleanup.push(project);
    const events: RuntimeEvent[] = [];
    const ac = new AbortController();

    // Agent that emits its result envelope, then lingers — mimics a
    // `claude --print` wedged on a leaked background child (a dev server,
    // an un-disowned build) that keeps the process, and so the tmux
    // session, alive indefinitely.
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: "wedge_session",
    });
    const wedgeAgent: AgentSpec = {
      name: "wedge",
      buildArgv() {
        return { argv: ["sh", "-c", `printf '%s\\n' '${resultLine}'; sleep 120`] };
      },
      parseLine: makeStubAgent().parseLine,
    };

    const start = Date.now();
    const result = await runtime.spawn({
      runId: `w${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      task: { id: "wedge-task", prompt: "" },
      agent: wedgeAgent,
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: 0, // infinite — only the grace backstop can end this run
      maxIterations: 1,
      abort: ac.signal,
      agentExitGraceMs: 1000,
      onEvent: (e) => events.push(e),
    });
    const elapsed = Date.now() - start;

    // The `sleep 120` would dominate without the grace backstop; finishing
    // fast proves the forced teardown fired.
    expect(elapsed).toBeLessThan(15_000);
    expect(events.some((e) => e.kind === "agent_exit")).toBe(true);
    expect(events.some((e) => e.kind === "raw" && e.line.includes("forcing teardown"))).toBe(true);
    // A grace teardown is NOT an abort — the run keeps its clean exit code.
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("idle watchdog reaps a silent agent on an unbounded budget", async () => {
    const project = await gitInitProject();
    cleanup.push(project);
    const events: RuntimeEvent[] = [];
    const ac = new AbortController();

    // Agent that produces NO output and never exits — the exact hang the
    // watchdog exists to catch. On an infinite budget only the idle watchdog
    // can end this run.
    const silentAgent: AgentSpec = {
      name: "silent",
      buildArgv() {
        return { argv: ["sleep", "60"] };
      },
      parseLine() {
        return [];
      },
    };

    const start = Date.now();
    const result = await runtime.spawn({
      runId: `i${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      task: { id: "idle-task", prompt: "" },
      agent: silentAgent,
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: 0, // infinite — proves the watchdog is independent of budget
      idleTimeoutSeconds: 1, // 1s of silence → reap (short for test speed)
      maxIterations: 1,
      abort: ac.signal,
      onEvent: (e) => events.push(e),
    });
    const elapsed = Date.now() - start;

    // `sleep 60` would dominate without the watchdog; finishing fast proves the
    // reap fired.
    expect(elapsed).toBeLessThan(10_000);
    expect(events.some((e) => e.kind === "idle_timeout")).toBe(true);
    expect(events.some((e) => e.kind === "raw" && e.line.includes("reaping idle run"))).toBe(true);
    // Not an operator abort, so no 130.
    expect(result.exitCode).toBe(0);
  }, 20_000);

  test("activity resets the idle clock — a run quiet under the window is NOT reaped", async () => {
    const project = await gitInitProject();
    cleanup.push(project);
    const events: RuntimeEvent[] = [];
    const ac = new AbortController();

    // Agent that speaks, goes quiet for LESS than the window, speaks again, then
    // finishes. Total runtime exceeds the idle window but no single silent gap
    // does — so a correct inactivity timer (reset on every activity) never
    // reaps it.
    const chattyAgent: AgentSpec = {
      name: "chatty",
      buildArgv() {
        const sys = JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "chatty_session",
        });
        const asst = JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "still working" }] },
        });
        const res = JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          session_id: "chatty_session",
        });
        const script = `printf '%s\\n' '${sys}'; sleep 1; printf '%s\\n' '${asst}'; sleep 1; printf '%s\\n' '${res}'`;
        return { argv: ["sh", "-c", script] };
      },
      parseLine: makeStubAgent().parseLine,
    };

    const result = await runtime.spawn({
      runId: `r${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      task: { id: "resume-task", prompt: "" },
      agent: chattyAgent,
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: 0,
      idleTimeoutSeconds: 2, // window (2s) > each gap (1s), < total (~2.4s)
      maxIterations: 1,
      abort: ac.signal,
      onEvent: (e) => events.push(e),
    });

    // The 1s gaps never breach the 2s window, so the run runs to completion.
    expect(events.some((e) => e.kind === "idle_timeout")).toBe(false);
    expect(events.some((e) => e.kind === "agent_exit")).toBe(true);
    expect(result.sessionId).toBe("chatty_session");
    expect(result.exitCode).toBe(0);
  }, 20_000);

  test("idleTimeoutSeconds=0 disables the watchdog", async () => {
    const project = await gitInitProject();
    cleanup.push(project);
    const events: RuntimeEvent[] = [];
    const ac = new AbortController();

    // Silent agent that would be reaped if the watchdog were armed. With
    // idleTimeoutSeconds=0 the watchdog is off, so we must stop it ourselves
    // (via abort) — proving nothing else killed it in the meantime.
    const silentAgent: AgentSpec = {
      name: "silent-forever",
      buildArgv() {
        return { argv: ["sleep", "60"] };
      },
      parseLine() {
        return [];
      },
    };

    setTimeout(() => ac.abort(), 1500);
    await runtime.spawn({
      runId: `z${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      task: { id: "no-watchdog", prompt: "" },
      agent: silentAgent,
      sandbox: hostSandbox,
      strategy: { type: "head" },
      budgetSeconds: 0,
      idleTimeoutSeconds: 0, // disabled
      maxIterations: 1,
      abort: ac.signal,
      onEvent: (e) => events.push(e),
    });

    // No idle_timeout was ever emitted; only our abort ended the run.
    expect(events.some((e) => e.kind === "idle_timeout")).toBe(false);
  }, 20_000);
});
