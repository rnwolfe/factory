import { cn } from "../lib/cn.ts";

/**
 * The attention-group header — a mono eyebrow + optional count + a flex-1
 * hairline, color-coded by what the group means. Drives the inbox's four
 * groups and any other "sectioned by attention" surface.
 *
 *  - needs-you   → amber   (a decision/action is yours)
 *  - in-flight   → teal    (the system is working on it right now)
 *  - unattended  → dim teal ("done while you were away")
 *  - settling    → fg-3    (quiet / collapsed)
 */
export type AttentionTone = "needs-you" | "in-flight" | "unattended" | "settling";

const TONE: Record<AttentionTone, { text: string; line: string; dot: string | null }> = {
  "needs-you": {
    text: "text-[var(--color-accent)]",
    line: "bg-[var(--color-accent-line)]",
    dot: null,
  },
  "in-flight": {
    text: "text-[var(--color-working)]",
    line: "bg-[var(--color-working-line)]",
    dot: "bg-[var(--color-working)]",
  },
  unattended: {
    text: "text-[var(--color-working-dim)]",
    line: "bg-[var(--color-working-tint-line)]",
    dot: null,
  },
  settling: {
    text: "text-[var(--color-fg-3)]",
    line: "bg-[var(--color-line)]",
    dot: null,
  },
};

export function AttentionHeader({
  label,
  count,
  tone,
  className,
}: {
  label: string;
  count?: number;
  tone: AttentionTone;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {t.dot ? <span className={cn("w-1.5 h-1.5 rounded-full pulse-dot", t.dot)} /> : null}
      <span className={cn("mono text-[10.5px] uppercase tracking-[0.18em]", t.text)}>{label}</span>
      {typeof count === "number" ? (
        <span className={cn("mono text-[10.5px] tabular-nums", t.text)}>{count}</span>
      ) : null}
      <span className={cn("flex-1 h-px", t.line)} />
    </div>
  );
}
