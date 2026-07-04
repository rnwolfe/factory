import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { type DecisionRow, decisionProjectLabel } from "./decision-card.tsx";
import { SourceIssueLink } from "./source-link.tsx";

type DecisionAction = "approve" | "park" | "trash" | "decompose" | "dismiss" | "scaffold_skill";

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function DetailShell({
  chips,
  title,
  fullHref,
  children,
}: {
  chips: React.ReactNode;
  title: React.ReactNode;
  fullHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="surface p-5">
      <div className="flex flex-wrap items-center gap-1.5 mb-3">{chips}</div>
      <h2 className="display text-[18px] leading-snug text-[var(--color-fg)] mb-4 break-words [overflow-wrap:anywhere]">
        {title}
      </h2>
      <div className="space-y-3 text-[13px] leading-relaxed text-[var(--color-fg-1)]">
        {children}
      </div>
      <div className="hairline mt-5" />
      <Link
        to={fullHref}
        className="mt-4 mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-2)] hover:text-[var(--color-fg-1)] flex items-center gap-1.5"
      >
        open full view <ArrowRight size={12} />
      </Link>
    </div>
  );
}

/**
 * Multi-select detail for a bulk `issue_import` decision: the untracked upstream
 * issues are listed as checkboxes (all checked by default); approve adopts only
 * the checked subset. Own component so its checkbox state lives outside the
 * generic decision detail's conditional-hook-free body.
 */
export function IssueImportDetail({
  row,
  onAction,
  compact = false,
}: {
  row: DecisionRow;
  onAction: (a: DecisionAction, selectedIssues?: number[]) => void;
  compact?: boolean;
}) {
  const candidates = useMemo(
    () => (Array.isArray(row.payload?.candidates) ? row.payload.candidates : []),
    [row.payload?.candidates],
  );
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(candidates.map((c) => c.number)),
  );
  const toggle = (n: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  const allSelected = selected.size === candidates.length && candidates.length > 0;
  const chosen = candidates.filter((c) => selected.has(c.number)).map((c) => c.number);

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[var(--color-fg-2)]">
          {candidates.length} existing issue{candidates.length === 1 ? "" : "s"} in the upstream
          repo — pick which to adopt as tasks. Factory reads each and infers dependencies + priority
          from the description; adopted work lands in triage for you to review.
        </p>
        <button
          type="button"
          onClick={() =>
            setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.number)))
          }
          className="mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-fg-2)] hover:text-[var(--color-fg)] shrink-0"
        >
          {allSelected ? "clear all" : "select all"}
        </button>
      </div>
      <ul className="space-y-1 max-h-[320px] overflow-y-auto pr-1">
        {candidates.map((c) => (
          <li key={c.number}>
            <label className="flex items-start gap-2 py-1 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(c.number)}
                onChange={() => toggle(c.number)}
                className="mt-0.5 shrink-0 accent-[hsl(22_65%_50%)]"
              />
              <span className="min-w-0">
                <SourceIssueLink
                  number={c.number}
                  title={c.title}
                  href={c.htmlUrl ?? null}
                  onClick={(e) => e.stopPropagation()}
                  className="break-words [overflow-wrap:anywhere]"
                />
                <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-1.5">
                  @{c.author}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 pt-2">
        <button
          type="button"
          disabled={chosen.length === 0}
          onClick={() => onAction("approve", chosen)}
          className="btn btn-primary flex-1 min-w-[120px] disabled:opacity-40"
        >
          adopt {chosen.length} {chosen.length === 1 ? "issue" : "issues"}
        </button>
        <button type="button" onClick={() => onAction("dismiss")} className="btn">
          dismiss
        </button>
      </div>
    </>
  );

  if (compact) return <div className="space-y-3 text-[13px] leading-relaxed">{body}</div>;

  return (
    <DetailShell
      chips={
        <>
          <span className="chip">issues · import</span>
          <span className="chip">{decisionProjectLabel(row)}</span>
          <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-auto">
            {timeAgo(row.createdAt)} ago
          </span>
        </>
      }
      title="Import existing issues"
      fullHref={`/decisions/${row.id}`}
    >
      {body}
    </DetailShell>
  );
}
