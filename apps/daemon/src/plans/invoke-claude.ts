import { claudeCodeAgent, type StreamEvent } from "@factory/runtime";
import { spawn as bunSpawn } from "bun";

/**
 * One-shot `claude --print` invocation that pipes a prompt and concatenates
 * every text event the agent emits. Used by triage and plan iteration —
 * neither flow uses `runtime.spawn` (no worktree, no tmux, no commits).
 *
 * Mirrors the helper that lives in `triage/orchestrate.ts`. Pulled out so
 * plan iteration doesn't fork the same code path.
 */
export async function invokeClaudeJson(prompt: string, budgetSeconds: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetSeconds * 1000);

  const { argv, stdin } = claudeCodeAgent.buildArgv(prompt, {});
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
        }
        idx = buf.indexOf("\n");
      }
    }
    if (buf.length > 0) {
      const events = claudeCodeAgent.parseLine(buf);
      for (const e of events) if (e.kind === "text") resultText += e.text;
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
  return resultText;
}
