import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn, type Subprocess } from "bun";
import type { EventBus } from "../events.ts";
import { UrlScanner } from "./url-detect.ts";

export interface RunningScript {
  id: string;
  projectId: string;
  scriptName: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: "running" | "exited" | "killed" | "failed";
  urls: string[];
  /** Last ~32 KB of output for late subscribers (so the PWA gets a starter view). */
  tail: string;
}

export interface ScriptStartInput {
  projectId: string;
  scriptName: string;
  command: string;
  cwd: string;
}

const TAIL_BYTES = 32 * 1024;

/**
 * In-memory ephemeral process registry. Survives daemon uptime; resets on
 * restart. Each script handle gets a unique id so the PWA's `/ws/script/:id`
 * channel can subscribe to its bytes.
 */
export class ScriptRegistry {
  private byId = new Map<string, Internal>();
  private byProjectAndName = new Map<string, string>();
  private events: EventBus;

  constructor(events: EventBus) {
    this.events = events;
  }

  active(projectId?: string): RunningScript[] {
    const all = Array.from(this.byId.values());
    const filtered = projectId ? all.filter((s) => s.projectId === projectId) : all;
    return filtered.map(toRunningScript);
  }

  get(id: string): RunningScript | null {
    const v = this.byId.get(id);
    return v ? toRunningScript(v) : null;
  }

  start(input: ScriptStartInput): { handle: RunningScript } {
    const key = `${input.projectId}::${input.scriptName}`;
    const existing = this.byProjectAndName.get(key);
    if (existing) {
      const v = this.byId.get(existing);
      if (v && v.status === "running") {
        throw new ScriptError(
          "already_running",
          `script ${input.scriptName} is already running for this project (id=${existing})`,
        );
      }
    }
    const id = createId();
    const proc = bunSpawn({
      cmd: ["sh", "-c", input.command],
      cwd: input.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const v: Internal = {
      id,
      projectId: input.projectId,
      scriptName: input.scriptName,
      command: input.command,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      status: "running",
      proc,
      scanner: new UrlScanner(),
      tailChunks: [],
      tailBytes: 0,
    };
    this.byId.set(id, v);
    this.byProjectAndName.set(key, id);
    this.pumpStream(v, proc.stdout);
    this.pumpStream(v, proc.stderr);
    void this.watchExit(v);
    return { handle: toRunningScript(v) };
  }

  async stop(id: string): Promise<{ ok: true }> {
    const v = this.byId.get(id);
    if (!v) throw new ScriptError("not_found", `script ${id} not found`);
    if (v.status !== "running") return { ok: true };
    try {
      v.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // SIGKILL fallback after 5 seconds.
    const killTimer = setTimeout(() => {
      try {
        if (v.status === "running") v.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 5_000);
    void v.proc.exited.finally(() => clearTimeout(killTimer));
    return { ok: true };
  }

  /** Best-effort kill all running scripts on daemon shutdown. */
  killAll(): void {
    for (const v of this.byId.values()) {
      if (v.status === "running") {
        try {
          v.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  }

  private async pumpStream(v: Internal, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const text = decoder.decode(value, { stream: true });
        v.scanner.feed(text);
        // Append to tail, trim to TAIL_BYTES.
        v.tailChunks.push(text);
        v.tailBytes += text.length;
        while (v.tailBytes > TAIL_BYTES && v.tailChunks.length > 1) {
          const dropped = v.tailChunks.shift();
          if (dropped) v.tailBytes -= dropped.length;
        }
        // Broadcast bytes to /ws/script/:id subscribers.
        this.events.publish({
          channel: "script",
          scriptId: v.id,
          bytes: value,
        });
      }
    } catch {
      // stream closed unexpectedly — exit handler will reconcile status
    }
  }

  private async watchExit(v: Internal): Promise<void> {
    const code = await v.proc.exited;
    v.endedAt = Date.now();
    v.exitCode = code;
    v.status = code === 0 ? "exited" : code === 143 || code === 137 ? "killed" : "failed";
    // Emit a final "exit" record so the PWA can update its status chip.
    this.events.publish({
      channel: "script",
      scriptId: v.id,
      bytes: new TextEncoder().encode(`\n[script exited with code ${code}]\n`),
    });
  }
}

interface Internal {
  id: string;
  projectId: string;
  scriptName: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: "running" | "exited" | "killed" | "failed";
  proc: Subprocess<"ignore", "pipe", "pipe">;
  scanner: UrlScanner;
  tailChunks: string[];
  tailBytes: number;
}

function toRunningScript(v: Internal): RunningScript {
  return {
    id: v.id,
    projectId: v.projectId,
    scriptName: v.scriptName,
    command: v.command,
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    exitCode: v.exitCode,
    status: v.status,
    urls: v.scanner.list(),
    tail: v.tailChunks.join(""),
  };
}

export class ScriptError extends Error {
  constructor(
    public readonly code: "already_running" | "not_found" | "no_workdir",
    message: string,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}
