import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * Pull-to-refresh gesture wiring for a vertical scroll container.
 *
 * Mounted once at the app shell so every route inherits the affordance
 * without per-route plumbing (see components/pull-to-refresh.tsx). The
 * gesture is deliberately conservative so it never fights normal use:
 *
 * 1. **Touch only.** Listeners key off touch events, so desktop pointer /
 *    wheel scrolling never engages it. (A touch-laptop pulling down is a
 *    perfectly fine, if rare, way to refresh — we don't actively block it.)
 * 2. **Scroll-at-top only.** A pull is a candidate only when the container
 *    is already scrolled to the very top at touchstart. Mid-scroll drags
 *    fall through to native scrolling untouched.
 * 3. **Downward + vertical only.** Once movement crosses a small slop, the
 *    gesture engages only if it is a downward, vertical-dominant drag.
 *    Upward or horizontal-dominant gestures cancel the candidate and hand
 *    control back to the browser.
 * 4. **Opt-out islands.** Touches originating inside an xterm pane (or any
 *    element marked `[data-no-pull-refresh]`) are ignored, so terminal
 *    scrollback and other self-scrolling widgets keep their own gestures.
 *
 * Honors the mobile invariant (docs/desktop-spec.md §7): mobile scrolling
 * is unchanged except for a deliberate pull past the top edge.
 */

// Raw finger travel asymptotes to MAX_PULL px of (damped) offset — the
// rubber-band never runs away even on a long drag.
const MAX_PULL = 110;
// Damped offset at which a release triggers a refresh.
const TRIGGER = 64;
// Resting offset held while the refresh is in flight (spinner parking spot).
const REST = 52;
// Movement (px) before we commit to a gesture direction.
const DIRECTION_SLOP = 6;
// Floor on visible spinner time so a fast refetch doesn't flash-and-vanish.
const MIN_SPINNER_MS = 450;

export interface PullToRefreshState {
  /** Current vertical offset in px to translate the content/indicator by. */
  pull: number;
  /** Finger is down and actively pulling (drives 1:1 follow vs. snap-back). */
  dragging: boolean;
  /** An onRefresh() call is in flight. */
  refreshing: boolean;
  /** Pull has passed TRIGGER — releasing now will refresh. */
  armed: boolean;
}

const IDLE: PullToRefreshState = {
  pull: 0,
  dragging: false,
  refreshing: false,
  armed: false,
};

/**
 * Map raw downward finger travel to a damped pull offset that approaches
 * `max` asymptotically — natural rubber-band resistance with no hard stop.
 * Pure and exported so the curve is unit-testable.
 */
export function resist(distance: number, max: number = MAX_PULL): number {
  if (distance <= 0) return 0;
  return max * (1 - Math.exp(-distance / max));
}

/** Whether a touch on `target` should be ignored (self-scrolling island). */
function isOptOut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(".xterm, [data-no-pull-refresh]") !== null;
}

export function usePullToRefresh(
  containerRef: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown>,
): PullToRefreshState {
  const [state, setState] = useState<PullToRefreshState>(IDLE);

  // Keep the latest onRefresh without re-binding listeners every render.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Per-gesture mutable state — refs, not React state, so move handling
    // never depends on a stale render.
    let startY = 0;
    let startX = 0;
    let engaged = false; // committed to a pull this gesture
    let candidate = false; // touch began at top, direction undecided
    let damped = 0; // latest damped offset
    let refreshing = false; // a refresh is in flight (ignore new touches)
    let cancelled = false; // effect torn down (guard async setState)

    const reset = () => {
      engaged = false;
      candidate = false;
      damped = 0;
      if (!cancelled) setState(IDLE);
    };

    const runRefresh = () => {
      refreshing = true;
      engaged = false;
      candidate = false;
      setState({ pull: REST, dragging: false, refreshing: true, armed: true });
      const minDelay = new Promise<void>((r) => setTimeout(r, MIN_SPINNER_MS));
      void Promise.allSettled([Promise.resolve(onRefreshRef.current()), minDelay]).then(() => {
        refreshing = false;
        if (!cancelled) setState(IDLE);
      });
    };

    const onStart = (e: TouchEvent) => {
      if (refreshing) return;
      if (e.touches.length !== 1) {
        candidate = false;
        return;
      }
      const t = e.touches[0];
      if (!t || isOptOut(e.target)) {
        candidate = false;
        return;
      }
      // Only a pull that begins at the very top is a candidate.
      if (el.scrollTop > 0) {
        candidate = false;
        return;
      }
      startY = t.clientY;
      startX = t.clientX;
      candidate = true;
      engaged = false;
      damped = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (!candidate || refreshing) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY;
      const dx = t.clientX - startX;

      if (!engaged) {
        // Wait until the gesture clears the slop before committing.
        if (Math.abs(dy) < DIRECTION_SLOP && Math.abs(dx) < DIRECTION_SLOP) return;
        // Upward or horizontal-dominant → not a pull; release to native.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          candidate = false;
          return;
        }
        engaged = true;
      }

      // A scroll back above the start point disengages and restores native
      // scrolling rather than pinning the content at the top.
      if (dy <= 0) {
        reset();
        return;
      }

      // We own this gesture now — stop native overscroll / pull-to-refresh.
      if (e.cancelable) e.preventDefault();
      damped = resist(dy);
      setState({ pull: damped, dragging: true, refreshing: false, armed: damped >= TRIGGER });
    };

    const onEnd = () => {
      if (!engaged || refreshing) {
        if (!refreshing) candidate = false;
        return;
      }
      if (damped >= TRIGGER) runRefresh();
      else reset();
    };

    // touchmove must be non-passive so preventDefault() can suppress the
    // browser's own overscroll once we've claimed the gesture. The rest stay
    // passive — they never block.
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", reset, { passive: true });

    return () => {
      cancelled = true;
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", reset);
    };
  }, [containerRef]);

  return state;
}
