import { claudeCodeAgent, type StreamEvent } from "@factory/runtime";
import { spawn as bunSpawn } from "bun";

export interface InvokeClaudeOptions {
  budgetSeconds: number;
  /**
   * When set, claude is invoked with `--resume <id>` so the prior session's
   * messages stay in the agent's context. The `prompt` argument is then
   * treated as a follow-up turn instead of a fresh task. When the resume
   * fails (session evicted, etc.), the caller should retry with this
   * option omitted and a full prompt.
   */
  resumeSessionId?: string;
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
}

/**
 * One-shot `claude --print` invocation. Used by triage and plan iteration —
 * neither flow uses `runtime.spawn` (no worktree, no tmux, no commits).
 *
 * Returns both the assistant text and the session id so plan iteration can
 * thread the conversation across operator comments instead of replaying the
 * full prompt + thread on every turn.
 */
export async function invokeClaudeJson(
  prompt: string,
  opts: InvokeClaudeOptions,
): Promise<InvokeClaudeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.budgetSeconds * 1000);

  const { argv, stdin } = claudeCodeAgent.buildArgv(prompt, {
    resumeSessionId: opts.resumeSessionId,
  });
  const proc = bunSpawn({
    cmd: argv as string[],
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
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const events: readonly StreamEvent[] = claudeCodeAgent.parseLine(line);
        for (const e of events) {
          if (e.kind === "text") resultText += e.text;
          if (e.kind === "session") sessionId = e.id;
        }
        idx = buf.indexOf("\n");
      }
    }
    if (buf.length > 0) {
      const events = claudeCodeAgent.parseLine(buf);
      for (const e of events) {
        if (e.kind === "text") resultText += e.text;
        if (e.kind === "session") sessionId = e.id;
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && !resultText) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
  }
  return { text: resultText, sessionId };
}
