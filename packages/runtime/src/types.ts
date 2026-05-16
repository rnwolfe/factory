/**
 * Per-model usage breakdown captured from the CLI's result envelope. Field
 * names mirror the CLI's camelCase output (`modelUsage`).
 */
export interface AgentModelUsage {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Final-result metrics extracted from `claude --print --output-format
 * stream-json`'s `result` envelope. Aggregate fields are summed across all
 * models the session used; `modelUsage` keeps the per-model breakdown for
 * later analysis. Carrier of cost/cache visibility for runtime ROI tracking.
 */
export interface AgentMetrics {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string | null;
  modelUsage: Record<string, AgentModelUsage>;
  isError: boolean;
  subtype: string | null;
  sessionId: string | null;
}

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; argSummary: string }
  | { kind: "session"; id: string }
  | { kind: "iteration_start"; iteration: number; ts: number }
  | { kind: "iteration_end"; iteration: number; exitCode: number; ts: number }
  | { kind: "commit"; sha: string; subject: string }
  | { kind: "idle_timeout"; ts: number }
  | { kind: "agent_exit"; exitCode: number; ts: number }
  /**
   * The agent stopped because the account hit its usage cap. `resetsAt` is
   * the epoch-ms the cap is expected to lift (parsed from the CLI message),
   * or null when the reset time could not be parsed.
   */
  | { kind: "usage_limit"; resetsAt: number | null; message: string }
  | { kind: "decision_required"; question: string; options?: string[] }
  | { kind: "metrics"; metrics: AgentMetrics }
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

export type BranchStrategy =
  | {
      type: "head";
      /**
       * Optional ref the per-run branch is created from. Defaults to the
       * project's HEAD. Override is used by the retry path so a new run can
       * resume from a prior run's branch tip.
       */
      baseRef?: string;
    }
  | { type: "branch"; name: string; baseRef?: string };

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
  /** Absolute path for the worktree. Defaults to `<projectPath>/worktrees/<branch>`. */
  worktreePath?: string;
  /** Author identity used when the runtime auto-commits residual dirty state. */
  gitAuthor?: { name: string; email: string };
  /** Claude model id forwarded to the agent's CLI. Null/undefined = CLI default. */
  model?: string | null;
  /**
   * Grace window (ms) after the agent's result envelope before the runtime
   * force-closes a tmux session that won't exit on its own. Defaults to 30s;
   * tests override it to a small value.
   */
  agentExitGraceMs?: number;
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
