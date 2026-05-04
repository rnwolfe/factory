import { cn } from "../lib/cn.ts";
import type { AuditFinding } from "./audit-card.tsx";

interface Props {
  finding: AuditFinding;
  selected?: boolean;
  onToggle?: () => void;
}

const SEVERITY_CHIP: Record<AuditFinding["severity"], string> = {
  critical: "chip-trashed",
  major: "chip-decompose",
  minor: "chip",
  enhancement: "chip-accent",
};

export function FindingCard({ finding, selected, onToggle }: Props) {
  const interactive = typeof onToggle === "function" && finding.promotedTo === null;
  const Wrapper = interactive ? "label" : "div";
  return (
    <Wrapper
      className={cn(
        "surface block px-3.5 py-3 transition-colors",
        interactive && "cursor-pointer hover:bg-[var(--color-bg-2)]",
        selected && "ring-1 ring-[var(--color-accent)]",
      )}
    >
      <div className="flex items-start gap-2">
        {interactive ? (
          <input
            type="checkbox"
            className="mt-1 accent-[var(--color-accent)]"
            checked={!!selected}
            onChange={onToggle}
          />
        ) : (
          <span className="mt-1 inline-block h-3 w-3 rounded-sm border border-[var(--color-fg-3)] opacity-40" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("chip", SEVERITY_CHIP[finding.severity])}>{finding.severity}</span>
            {finding.promotedTo ? (
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
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-2)] whitespace-pre-wrap">
              {finding.body}
            </p>
          ) : null}
        </div>
      </div>
    </Wrapper>
  );
}
