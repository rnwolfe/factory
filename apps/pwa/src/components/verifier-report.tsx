import { ShieldCheck } from "lucide-react";

export type VerifierLevel = "none" | "low" | "medium" | "high";
export type VerifierSignalKey = "acceptance" | "quality" | "cross-model";
export type VerifierSignalState = "pass" | "fail" | "absent";

export interface VerifierSignalView {
  key: VerifierSignalKey;
  label: string;
  state: VerifierSignalState;
  detail: string;
}

export interface VerifierReportView {
  /** 0..1 */
  score: number;
  level: VerifierLevel;
  signals: VerifierSignalView[];
}

interface Props {
  /** Already-parsed verifier report. Pass null for "no verifier report yet". */
  report: VerifierReportView | null;
}

/**
 * Parse the run's `verifierReport` JSON string into a typed view. Returns null
 * for missing/empty/unparseable payloads — mirrors how live-pane parses
 * `qualityReport`. Render `<VerifierReport>` with the result; it renders a
 * muted "no coverage recorded" note when null.
 */
export function parseVerifierReport(raw: string | null | undefined): VerifierReportView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VerifierReportView;
    if (typeof parsed?.score !== "number" || !Array.isArray(parsed?.signals)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** high → greenlit, medium → parked (amber), low → muted default, none → trashed (red). */
function levelChip(level: VerifierLevel): string {
  switch (level) {
    case "high":
      return "chip-greenlit";
    case "medium":
      return "chip-parked";
    case "none":
      return "chip-trashed";
    default:
      // low — plain chip reads as muted/neutral.
      return "";
  }
}

export function VerifierReport({ report }: Props) {
  if (!report) {
    return (
      <div className="surface mt-2 px-3 py-2.5 mono text-[11px] text-[var(--color-fg-3)]">
        no verification coverage recorded for this run.
      </div>
    );
  }

  const pct = Math.round(Math.max(0, Math.min(1, report.score)) * 100);

  return (
    <div className="surface mt-2 p-0 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-[var(--color-line)] flex items-center gap-2">
        <ShieldCheck size={13} className="text-[var(--color-fg-3)] shrink-0" />
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          verified ({report.signals.length})
        </span>
        <div className="flex-1" />
        <span className={`chip ${levelChip(report.level)}`}>
          {report.level} · {pct}%
        </span>
      </div>
      {report.signals.length > 0 ? (
        <ul className="divide-y divide-[var(--color-line)]">
          {report.signals.map((s) => (
            <SignalRow key={s.key} signal={s} />
          ))}
        </ul>
      ) : (
        <div className="px-3 py-2.5 mono text-[11px] text-[var(--color-fg-3)]">
          no verification signals were evaluated.
        </div>
      )}
    </div>
  );
}

function SignalRow({ signal }: { signal: VerifierSignalView }) {
  const { glyph, glyphClass, tag, tagClass } = renderState(signal.state);
  return (
    <li className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className={`mono text-[11px] tabular-nums w-4 text-center shrink-0 ${glyphClass}`}>
          {glyph}
        </span>
        <span className="text-[13px] text-[var(--color-fg-1)] leading-snug flex-1">
          {signal.label}
        </span>
        {tag ? (
          <span className={`mono text-[10px] uppercase tracking-[0.14em] shrink-0 ${tagClass}`}>
            {tag}
          </span>
        ) : null}
      </div>
      {signal.detail ? (
        <p className="mt-1 ml-6 mono text-[11px] text-[var(--color-fg-2)] break-words leading-snug">
          {signal.detail}
        </p>
      ) : null}
    </li>
  );
}

/**
 * State → visual. `absent` is the load-bearing case: it must read as "nothing
 * checked this", not as a pass — so it gets a muted dashed glyph plus an
 * explicit "not covered" tag rather than a check.
 */
function renderState(state: VerifierSignalState): {
  glyph: string;
  glyphClass: string;
  tag: string | null;
  tagClass: string;
} {
  switch (state) {
    case "pass":
      return {
        glyph: "✓",
        glyphClass: "text-[var(--color-verdict-greenlit)]",
        tag: null,
        tagClass: "",
      };
    case "fail":
      return {
        glyph: "✗",
        glyphClass: "text-[var(--color-verdict-trashed)]",
        tag: "failed",
        tagClass: "text-[var(--color-verdict-trashed)]",
      };
    default:
      // absent — dashed, muted, never reads as a pass.
      return {
        glyph: "—",
        glyphClass: "text-[var(--color-fg-3)]",
        tag: "not covered",
        tagClass: "text-[var(--color-fg-3)]",
      };
  }
}
