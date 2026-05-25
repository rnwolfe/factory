import {
  type AgentMetrics,
  type AgentSpec,
  claudeCodeAgent,
  codexAgent,
  type StreamEvent,
} from "@factory/runtime";
import { spawn as bunSpawn } from "bun";

/**
 * Supported headless agents. Adding a third entry here requires (1) an
 * AgentSpec in `packages/runtime/src/agents/`, (2) a row in `agentByName`
 * below, and (3) entries in `SUPPORTED_AGENTS` (`workers/submit.ts`) +
 * `agentForRow` (`workers/runner.ts`) for the run path.
 */
export type AgentName = "claude-code" | "codex";

export const SUPPORTED_AGENT_NAMES: readonly AgentName[] = ["claude-code", "codex"] as const;

/** Resolve an agent name to its AgentSpec. */
export function agentByName(name: AgentName): AgentSpec {
  switch (name) {
    case "codex":
      return codexAgent;
    case "claude-code":
      return claudeCodeAgent;
  }
}

/**
 * Whether the agent's underlying CLI supports `--resume <session>` to pick
 * up a prior conversation. Callers that rely on resume (`renderFollowUpPrompt`
 * patterns where the follow-up prompt is short and assumes prior thread in
 * context) MUST either fall back to a full prompt when this returns false,
 * or surface a parity error to the operator. See `docs/internal/codex-parity.md`.
 */
export function agentSupportsResume(name: AgentName): boolean {
  return name === "claude-code";
}

export interface InvokeClaudeOptions {
  budgetSeconds: number;
  /**
   * Which headless agent to dispatch to. Defaults to "claude-code" for
   * backward-compat with sites that haven't been agent-aware yet. New
   * callers should resolve the effective agent up-front and pass it
   * explicitly.
   */
  agent?: AgentName;
  /**
   * When set, the agent is invoked with `--resume <id>` so the prior
   * session's messages stay in its context. The `prompt` argument is then
   * treated as a follow-up turn instead of a fresh task. When the resume
   * fails (session evicted, etc.), the caller should retry with this
   * option omitted and a full prompt.
   *
   * If `agent` is one that does not support resume (e.g. codex), passing
   * a `resumeSessionId` is a programming error and this function will
   * throw a clear ResumeUnsupportedError — callers must guard at their
   * own layer (rebuild full prompt, or surface a parity-block to the
   * operator at run-spawn time). See ADR-006.
   */
  resumeSessionId?: string;
  /**
   * Spawn the agent with this working directory. Used by exec audits so the
   * agent's shell tools (Bash, Read, etc.) operate against the audit's
   * worktree. Default: daemon's cwd, which is fine for read-only invocations
   * that don't shell out into project source.
   */
  cwd?: string;
}

/**
 * Thrown when a caller asks for session resume against an agent that does
 * not support it (e.g. codex). Callers should catch and rebuild the full
 * prompt, or fail with a parity-block error to the operator.
 */
export class ResumeUnsupportedError extends Error {
  readonly agentName: AgentName;
  constructor(agentName: AgentName) {
    super(
      `agent "${agentName}" does not support session resume — rebuild the full prompt instead (see docs/internal/codex-parity.md)`,
    );
    this.name = "ResumeUnsupportedError";
    this.agentName = agentName;
  }
}

export interface InvokeClaudeResult {
  /** Concatenated assistant text output across all stream events. */
  text: string;
  /**
   * The session id reported by the CLI. On a fresh invocation this is a new
   * session; on a `--resume` invocation it is the resumed session's id (which
   * the CLI may rotate, so callers should always store the latest value).
   */
  sessionId: string | null;
  /**
   * Final-result metrics from the CLI's stream-json `result` envelope (cost,
   * tokens, duration, per-model usage). Null/undefined when the CLI exited
   * before emitting a result event, or when the test seam mocks the invoker
   * — callers should treat absence as "no metrics this turn" and continue.
   */
  metrics?: AgentMetrics | null;
}

/**
 * One-shot headless agent invocation. Used by triage and plan iteration —
 * neither flow uses `runtime.spawn` (no worktree, no tmux, no commits).
 *
 * Despite the legacy name, the agent is selected by `opts.agent` (defaults
 * to claude-code). Renaming is deferred — see codex-parity inventory.
 *
 * Returns both the assistant text and the session id so plan iteration can
 * thread the conversation across operator comments instead of replaying the
 * full prompt + thread on every turn.
 */
export async function invokeClaudeJson(
  prompt: string,
  opts: InvokeClaudeOptions,
): Promise<InvokeClaudeResult> {
  const agentName: AgentName = opts.agent ?? "claude-code";
  const agent = agentByName(agentName);

  if (opts.resumeSessionId && !agentSupportsResume(agentName)) {
    throw new ResumeUnsupportedError(agentName);
  }

  const ac = new AbortController();
  // budgetSeconds=0 means unlimited (matches running the CLI directly).
  const timer =
    opts.budgetSeconds > 0 ? setTimeout(() => ac.abort(), opts.budgetSeconds * 1000) : null;

  const { argv, stdin } = agent.buildArgv(prompt, {
    resumeSessionId: opts.resumeSessionId,
  });
  const proc = bunSpawn({
    cmd: argv as string[],
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: ac.signal,
  });
  if (proc.stdin) {
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
    }
    await proc.stdin.end();
  }

  let resultText = "";
  let sessionId: string | null = null;
  let metrics: AgentMetrics | null = null;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleEvents = (events: readonly StreamEvent[]) => {
    for (const e of events) {
      if (e.kind === "text") resultText += e.text;
      else if (e.kind === "session") sessionId = e.id;
      else if (e.kind === "metrics") metrics = e.metrics;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleEvents(agent.parseLine(line));
        idx = buf.indexOf("\n");
      }
    }
    if (buf.length > 0) {
      handleEvents(agent.parseLine(buf));
    }
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !resultText) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${agentName} exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
  }
  return { text: resultText, sessionId, metrics };
}
