import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * The unattended marker. "the system did this, FYI" — distinct from the amber
 * "needs you" surface. Mono 9px uppercase teal, e.g. `auto · merged`, `auto · ran`.
 *
 * When the emergency stop is engaged, pass `paused` so the chrome reads halted
 * (the autonomy spec: flipping the kill-switch visibly changes `auto` chrome).
 */
export function AutoChip({
  children,
  paused = false,
  className,
}: {
  children: ReactNode;
  paused?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("chip-auto", paused && "chip-auto-paused", className)}>{children}</span>
  );
}
