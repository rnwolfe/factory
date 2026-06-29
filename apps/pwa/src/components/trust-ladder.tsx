import { cn } from "../lib/cn.ts";

/**
 * The trust ladder — "how far you've let it go", one of the three things the
 * surface must make legible at a glance. Three rungs: supervised → collaborative
 * → autonomous. Past + current rungs fill teal (dim, then bright-with-glow);
 * future rungs read as warm-neutral "not yet".
 *
 * The data model carries a 2-value `autonomyMode` (collaborative | autonomous);
 * the derived third rung, `supervised`, is the implicit floor (autorun off /
 * gate-all). The backend derives the rung; this component only renders it.
 *
 * Two sizes:
 *  - `inline` — 3 short bars + a mono label, for list rows (portfolio, posture).
 *  - `block`  — 3 labeled columns + the streak-toward-autonomous line, for the
 *               project autonomy tab.
 */
export type TrustRung = "supervised" | "collaborative" | "autonomous";

const RUNGS: TrustRung[] = ["supervised", "collaborative", "autonomous"];
const RUNG_INDEX: Record<TrustRung, number> = {
  supervised: 0,
  collaborative: 1,
  autonomous: 2,
};

function rungClass(idx: number, current: number): string {
  if (idx < current) return "rung-past";
  if (idx === current) return "rung-active";
  return "";
}

export function TrustLadder({
  rung,
  streak,
  target,
  size = "inline",
  className,
}: {
  rung: TrustRung;
  /** consecutive clean runs toward the next rung (optional). */
  streak?: number;
  /** clean-run target for promotion to autonomous (optional). */
  target?: number;
  size?: "inline" | "block";
  className?: string;
}) {
  const current = RUNG_INDEX[rung];

  if (size === "inline") {
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <span className="inline-flex items-center gap-1" aria-hidden>
          {RUNGS.map((r, i) => (
            <span
              key={r}
              className={cn("rung", rungClass(i, current))}
              style={{ width: 13, height: 4 }}
            />
          ))}
        </span>
        <span className="mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-working)]">
          {rung}
        </span>
      </span>
    );
  }

  // block — the autonomy-tab presentation.
  const showStreak =
    rung !== "autonomous" && typeof streak === "number" && typeof target === "number";
  return (
    <div className={cn("surface-2 p-3", className)}>
      <div className="flex items-end gap-2">
        {RUNGS.map((r, i) => {
          const state = rungClass(i, current);
          const active = i === current;
          return (
            <div key={r} className="flex-1 flex flex-col items-center gap-1.5">
              <span className={cn("w-full rung", state)} style={{ height: active ? 10 : 6 }} />
              <span
                className={cn(
                  "mono text-[9px] uppercase tracking-[0.12em] text-center leading-tight",
                  active
                    ? "text-[var(--color-working)]"
                    : i < current
                      ? "text-[var(--color-working-dim)]"
                      : "text-[var(--color-fg-3)]",
                )}
              >
                {r}
              </span>
            </div>
          );
        })}
      </div>
      {showStreak ? (
        <p className="mt-2.5 mono text-[10.5px] text-[var(--color-fg-2)] leading-snug">
          <span className="text-[var(--color-working)]">
            {streak} of {target}
          </span>{" "}
          clean runs toward autonomous · contracts on any failure
        </p>
      ) : rung === "autonomous" ? (
        <p className="mt-2.5 mono text-[10.5px] text-[var(--color-fg-2)] leading-snug">
          running itself · contracts on any failure
        </p>
      ) : null}
    </div>
  );
}
