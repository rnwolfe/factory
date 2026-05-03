export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; argSummary: string }
  | { kind: "session"; id: string }
  | { kind: "iteration_start"; iteration: number; ts: number }
  | { kind: "iteration_end"; iteration: number; exitCode: number; ts: number }
  | { kind: "commit"; sha: string; subject: string }
  | { kind: "idle_timeout"; ts: number }
  | { kind: "agent_exit"; exitCode: number; ts: number }
  | { kind: "decision_required"; question: string; options?: string[] }
  /**
   * One newline-terminated line of raw pane output as captured by `pipe-pane`.
   * Emitted in addition to any parsed events the agent extracts. Consumers
   * (e.g. the daemon's pane WebSocket channel) forward these to xterm.js.
   */
  | { kind: "raw"; line: string };

export type RuntimeEvent = StreamEvent & { runId: string; iteration: number };

export interface AgentSpec {
  readonly name: string;
  buildArgv(
    prompt: string,
    opts: {
      resumeSessionId?: string;
      model?: string;
    },
  ): {
    argv: readonly string[];
    stdin?: string;
    env?: Record<string, string>;
  };
  parseLine(line: string): readonly StreamEvent[];
  /** Returns true if the line indicates Claude needs re-auth or session resume. */
  detectStaleness?(line: string): boolean;
}

export interface SpawnOpts {
  worktreePath: string;
  argv: readonly string[];
  stdin?: string;
  env: Record<string, string>;
  abort: AbortSignal;
  /** Called once per newline-terminated line of pane output. MUST be incremental. */
  onLine: (line: string) => void;
  tmux: { sessionName: string; logSocketPath: string };
}

export interface SpawnHandle {
  readonly pid: number;
  readonly tmuxSession: string;
  exit: Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export interface SandboxSpec {
  readonly kind: "host";
  spawn(opts: SpawnOpts): Promise<SpawnHandle>;
}

export type BranchStrategy = { type: "head" } | { type: "branch"; name: string; baseRef?: string };

export interface RunSpec {
  runId: string;
  projectPath: string;
  task: { id: string; prompt: string };
  agent: AgentSpec;
  sandbox: SandboxSpec;
  strategy: BranchStrategy;
  budgetSeconds: number;
  maxIterations: number;
  abort: AbortSignal;
  onEvent: (e: RuntimeEvent) => void;
  resume?: { sessionId: string };
  /** Override default tmux session name; used by tests. */
  tmuxSessionName?: string;
  /** Override default log socket path; used by tests. */
  logSocketPath?: string;
  /** When true, leave the worktree on disk after the run finishes. Default: remove if clean. */
  preserveWorktree?: boolean;
}

export interface RunResult {
  runId: string;
  branch: string;
  worktreePath: string;
  commits: { sha: string; subject: string }[];
  sessionId?: string;
  exitCode: number;
  iterationsCompleted: number;
}

export interface Runtime {
  spawn(spec: RunSpec): Promise<RunResult>;
}
