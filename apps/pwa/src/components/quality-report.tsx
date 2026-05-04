import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

export interface QualityCheckResultView {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

export interface QualityReportView {
  ranAt: number;
  results: QualityCheckResultView[];
  overall: "pass" | "fail" | "skipped";
}

interface Props {
  /** Already-parsed quality report. Pass null for "no quality report yet". */
  report: QualityReportView | null;
}

export function QualityReportPanel({ report }: Props) {
  if (!report) {
    return (
      <div className="surface mt-2 px-3 py-2.5 mono text-[11px] text-[var(--color-fg-3)]">
        no quality checks recorded for this run.
      </div>
    );
  }

  if (report.overall === "skipped" && report.results.length === 0) {
    return (
      <div className="surface mt-2 px-3 py-2.5 mono text-[11px] text-[var(--color-fg-3)]">
        no quality checks configured for this project — add{" "}
        <span className="text-[var(--color-fg-1)]">.factory/quality.yaml</span> to opt in.
      </div>
    );
  }

  const overallChip =
    report.overall === "pass" ? "chip-greenlit" : report.overall === "fail" ? "chip-trashed" : "";

  return (
    <div className="surface mt-2 p-0 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-[var(--color-line)] flex items-center gap-2">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          quality ({report.results.length})
        </span>
        <div className="flex-1" />
        <span className={`chip ${overallChip}`}>{report.overall}</span>
      </div>
      <ul className="divide-y divide-[var(--color-line)]">
        {report.results.map((r) => (
          <CheckRow key={r.name} result={r} />
        ))}
      </ul>
    </div>
  );
}

function CheckRow({ result }: { result: QualityCheckResultView }) {
  const [open, setOpen] = useState(false);
  const failed = result.exitCode !== 0 || result.timedOut;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-[var(--color-bg-2)]"
      >
        {open ? (
          <ChevronDown size={11} className="text-[var(--color-fg-3)] shrink-0" />
        ) : (
          <ChevronRight size={11} className="text-[var(--color-fg-3)] shrink-0" />
        )}
        <span
          className={`mono text-[11px] tabular-nums w-4 text-center shrink-0 ${
            failed ? "text-[var(--color-verdict-trashed)]" : "text-[var(--color-verdict-greenlit)]"
          }`}
        >
          {failed ? "✗" : "✓"}
        </span>
        <span className="text-[13px] text-[var(--color-fg-1)] truncate flex-1">{result.name}</span>
        <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums shrink-0">
          {fmtMs(result.durationMs)}
        </span>
        {result.timedOut ? <span className="chip chip-trashed text-[10px]">timeout</span> : null}
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-2">
          <div className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {result.command} · exit {result.exitCode}
          </div>
          {result.stdoutTail.trim().length > 0 ? (
            <details>
              <summary className="mono text-[10.5px] text-[var(--color-fg-3)] cursor-pointer">
                stdout tail
              </summary>
              <pre className="mt-1 mono text-[11px] text-[var(--color-fg-1)] whitespace-pre-wrap break-words leading-snug max-h-[260px] overflow-y-auto">
                {result.stdoutTail}
              </pre>
            </details>
          ) : null}
          {result.stderrTail.trim().length > 0 ? (
            <details open={failed}>
              <summary
                className={`mono text-[10.5px] cursor-pointer ${
                  failed ? "text-[var(--color-verdict-trashed)]" : "text-[var(--color-fg-3)]"
                }`}
              >
                stderr tail
              </summary>
              <pre className="mt-1 mono text-[11px] text-[var(--color-fg-1)] whitespace-pre-wrap break-words leading-snug max-h-[260px] overflow-y-auto">
                {result.stderrTail}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}
