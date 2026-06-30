import { Link } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import type { AuditFinding } from "./audit-card.tsx";
import { MarkdownView } from "./markdown-view.tsx";

interface Props {
  finding: AuditFinding;
  selected?: boolean;
  onToggle?: () => void;
  promotedHref?: string | null;
}

const SEVERITY_CHIP: Record<AuditFinding["severity"], string> = {
  critical: "chip-trashed",
  major: "chip-decompose",
  minor: "chip",
  enhancement: "chip",
};

export function FindingCard({ finding, selected, onToggle, promotedHref }: Props) {
  const interactive = typeof onToggle === "function" && finding.promotedTo === null;
  const Wrapper = interactive ? "label" : "div";
  return (
    <Wrapper
      className={cn(
        "surface block px-3.5 py-3 transition-colors",
        interactive && "cursor-pointer hover:bg-[var(--color-bg-2)]",
        selected && "ring-1 ring-[var(--color-working)]",
      )}
    >
      <div className="flex items-start gap-2">
        {interactive ? (
          <input
            type="checkbox"
            className="mt-1 accent-[var(--color-working)]"
            checked={!!selected}
            onChange={onToggle}
          />
        ) : (
          <span className="mt-1 inline-block h-3 w-3 rounded-sm border border-[var(--color-fg-3)] opacity-40" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("chip", SEVERITY_CHIP[finding.severity])}>{finding.severity}</span>
            {finding.promotedTo && promotedHref ? (
              <Link to={promotedHref} className="chip">
                {finding.promotedTo.kind === "plan" ? "→ plan" : "→ task"}
              </Link>
            ) : finding.promotedTo ? (
              <span className="chip">
                {finding.promotedTo.kind === "plan" ? "→ plan" : "→ task"}
              </span>
            ) : null}
            {finding.filePath ? (
              <span className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                {finding.filePath}
                {finding.line !== null ? `:${finding.line}` : ""}
              </span>
            ) : null}
          </div>
          <div className="display mt-1.5 text-[15px] leading-snug text-[var(--color-fg)]">
            {finding.title}
          </div>
          {finding.body ? (
            <div className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-2)]">
              <MarkdownView source={finding.body} storageKey={`mdView.finding.${finding.id}`} />
            </div>
          ) : null}
        </div>
      </div>
    </Wrapper>
  );
}
