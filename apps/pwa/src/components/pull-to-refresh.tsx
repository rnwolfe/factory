import { RefreshCw } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { usePullToRefresh } from "../lib/use-pull-to-refresh.ts";

/**
 * App-shell scroll container with a pull-to-refresh affordance. Renders the
 * route's `<main>` and an amber indicator that descends from the top edge as
 * the operator pulls. Mounted once in the Shell so every route inherits it
 * (see lib/use-pull-to-refresh.ts for the gesture gating).
 *
 * `onRefresh` should resolve when the refresh has settled — the spinner is
 * held until then (with a small minimum so a cache-fast refetch still reads
 * as a deliberate action).
 */

// Keep in sync with the indicator's own height so it parks fully hidden above
// the top edge at rest (transform = pull - HIDDEN_OFFSET).
const HIDDEN_OFFSET = 40;
const SETTLE = "transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)";

export function PullToRefresh({
  onRefresh,
  className,
  children,
  ...rest
}: {
  onRefresh: () => Promise<unknown>;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  const { pull, dragging, refreshing, armed } = usePullToRefresh(ref, onRefresh);

  // 1:1 follow while the finger is down; ease on release / during refresh.
  const settle = dragging ? undefined : SETTLE;
  const progress = Math.min(pull / 64, 1);

  const badgeStyle: CSSProperties = {
    transform: `translateY(${pull - HIDDEN_OFFSET}px)`,
    opacity: refreshing ? 1 : progress,
    transition: settle ? `${settle}, opacity 0.15s linear` : "opacity 0.15s linear",
  };

  const iconStyle: CSSProperties = refreshing
    ? {}
    : {
        transform: `rotate(${progress * 270}deg)`,
        transition: dragging ? undefined : "transform 0.22s ease",
      };

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
      >
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-bg-1)] shadow-lg"
          style={badgeStyle}
        >
          <RefreshCw
            size={16}
            strokeWidth={2}
            className={cn(
              refreshing && "animate-spin",
              armed || refreshing ? "text-[var(--color-accent)]" : "text-[var(--color-fg-2)]",
            )}
            style={iconStyle}
          />
        </div>
      </div>

      <main
        ref={ref}
        className={className}
        style={{ transform: pull > 0 ? `translateY(${pull}px)` : undefined, transition: settle }}
        {...rest}
      >
        {children}
      </main>
    </div>
  );
}
