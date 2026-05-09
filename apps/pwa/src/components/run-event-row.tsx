import type { LucideIcon } from "lucide-react";
import {
  Bot,
  CircleAlert,
  CircleSlash,
  CornerDownRight,
  FileEdit,
  FileText,
  GitCommit,
  Globe,
  ListChecks,
  ListTodo,
  Search,
  ShieldCheck,
  Terminal as TerminalIcon,
  Wrench,
  XCircle,
} from "lucide-react";
export interface RunEvent {
  kind: string;
  iteration?: number;
  text?: string;
  name?: string;
  argSummary?: string;
  sha?: string;
  subject?: string;
  exitCode?: number;
  ts?: number;
  question?: string;
  options?: string[];
  /** quality_report payload */
  overall?: "pass" | "fail" | "skipped";
  /** metrics payload */
  metrics?: {
    totalCostUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  };
}

const TOOL_ICON: Record<string, LucideIcon> = {
  Read: FileText,
  Edit: FileEdit,
  Write: FileEdit,
  MultiEdit: FileEdit,
  NotebookEdit: FileEdit,
  Bash: TerminalIcon,
  Glob: Search,
  Grep: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListTodo,
  Task: Bot,
};

function iconForTool(name: string): LucideIcon {
  return TOOL_ICON[name] ?? Wrench;
}

/**
 * Strip ANSI escape sequences so terminal-color output (Bash stdout) doesn't
 * leak as garbage characters into the structured view. Lossy on purpose —
 * the raw xterm view preserves color via the [raw] toggle.
 */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are control chars by definition
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function RunEventRow({ event }: { event: RunEvent }) {
  switch (event.kind) {
    case "text": {
      // Plain pre — markdown rendering on hundreds of agent-text events
      // adds up to seconds of synchronous parsing on initial paint, which
      // can lock the main thread. The raw xterm view ([raw] toggle above)
      // still preserves the full stream including any color/formatting.
      const text = event.text ?? "";
      return (
        <div className="run-event run-event-text">
          <pre className="run-event-text-pre">{text}</pre>
        </div>
      );
    }

    case "tool": {
      const Icon = iconForTool(event.name ?? "");
      return (
        <div className="run-event run-event-tool">
          <Icon size={13} className="run-event-tool-icon" />
          <span className="run-event-tool-name">{event.name ?? "tool"}</span>
          <span className="run-event-tool-arg">{stripAnsi(event.argSummary ?? "")}</span>
        </div>
      );
    }

    case "commit":
      return (
        <div className="run-event run-event-commit">
          <GitCommit size={13} className="run-event-commit-icon" />
          <span className="mono text-[11px] text-[var(--color-accent)]">
            {(event.sha ?? "").slice(0, 8)}
          </span>
          <span className="run-event-commit-subject">{event.subject ?? ""}</span>
        </div>
      );

    case "iteration_start":
      return (
        <div className="run-event run-event-iteration">
          <CornerDownRight size={11} />
          <span>iteration {event.iteration ?? "?"} started</span>
        </div>
      );

    case "iteration_end":
      return (
        <div className="run-event run-event-iteration">
          <CornerDownRight size={11} />
          <span>
            iteration {event.iteration ?? "?"} ended (exit {event.exitCode ?? "?"})
          </span>
        </div>
      );

    case "agent_exit":
      return (
        <div
          className={`run-event run-event-exit ${
            event.exitCode === 0 ? "run-event-exit-ok" : "run-event-exit-bad"
          }`}
        >
          {event.exitCode === 0 ? <ListChecks size={13} /> : <XCircle size={13} />}
          <span>agent exited {event.exitCode ?? "?"}</span>
        </div>
      );

    case "metrics": {
      const m = event.metrics ?? {};
      const tokens = (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
      const cost = m.totalCostUsd ?? 0;
      const seconds = Math.round((m.durationMs ?? 0) / 1000);
      return (
        <div className="run-event run-event-metrics">
          <span>
            ${cost < 0.01 ? "<0.01" : cost.toFixed(2)} · {fmtTokens(tokens)} tok · {seconds}s
          </span>
        </div>
      );
    }

    case "quality_report":
      return (
        <div
          className={`run-event run-event-quality ${
            event.overall === "pass"
              ? "run-event-quality-ok"
              : event.overall === "skipped"
                ? "run-event-quality-skip"
                : "run-event-quality-bad"
          }`}
        >
          <ShieldCheck size={13} />
          <span>quality {event.overall ?? "?"}</span>
        </div>
      );

    case "decision_required":
      return (
        <div className="run-event run-event-decision">
          <CircleAlert size={14} />
          <div>
            <div className="run-event-decision-title">agent needs a decision</div>
            <div className="run-event-decision-q">{event.question ?? ""}</div>
            {event.options && event.options.length > 0 ? (
              <ul className="run-event-decision-opts">
                {event.options.map((o, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: options are positional and immutable
                  <li key={i}>{o}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      );

    case "idle_timeout":
      return (
        <div className="run-event run-event-iteration">
          <CircleSlash size={11} />
          <span>idle timeout</span>
        </div>
      );

    // session / raw / unknown — silently drop. The pane (xterm) view shows
    // raw bytes, so we don't surface them again here.
    default:
      return null;
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
