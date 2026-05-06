import type { Terminal } from "@xterm/xterm";

/**
 * Wire mobile touch handling to an xterm terminal. Handles three things
 * the default xterm setup gets wrong on a phone:
 *
 * 1. **Scrollback navigation.** xterm's `.xterm-viewport` is a native-scroll
 *    element behind the screen layer, but the screen layer absorbs touch
 *    events without translating them into viewport scroll. A vertical pan
 *    on the terminal goes nowhere. We translate touchmove deltas into
 *    `term.scrollLines(n)` calls so swipes navigate scrollback.
 *
 * 2. **Page-shell pull-down.** Without `preventDefault` on touchmove, the
 *    browser propagates the gesture up to the document and the entire app
 *    shell drags / pulls-to-refresh. The touchmove listener is non-passive
 *    so we can call `preventDefault()` once we've decided this is a
 *    terminal-scroll gesture.
 *
 * 3. **Tap-to-focus, swipe-doesn't-focus.** On mobile, focusing the
 *    terminal pops the on-screen keyboard. We only want that when the
 *    operator deliberately taps — not on every swipe-to-scroll. We detect
 *    taps as touches that ended in <250ms with <8px of movement; longer
 *    or wider gestures don't fire focus.
 *
 * Returns a cleanup that removes the listeners. Safe to call repeatedly.
 */
export function wireXtermTouchScroll(term: Terminal, container: HTMLElement): () => void {
  const TAP_MAX_MS = 250;
  const TAP_MAX_PX = 8;

  let active: {
    startX: number;
    startY: number;
    startTs: number;
    lastY: number;
    residualPx: number;
    moved: boolean;
  } | null = null;

  // Pixel-per-line approximation. xterm.options.fontSize is the cell height
  // basis; lineHeight is a multiplier. Underestimating slightly makes
  // scrolls feel snappier.
  const linePx = () => {
    const fs = term.options.fontSize ?? 12.5;
    const lh = term.options.lineHeight ?? 1.2;
    return Math.max(8, fs * lh);
  };

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      active = null;
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    active = {
      startX: t.clientX,
      startY: t.clientY,
      startTs: performance.now(),
      lastY: t.clientY,
      residualPx: 0,
      moved: false,
    };
  };

  const onMove = (e: TouchEvent) => {
    if (!active) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - active.startX);
    const dy = Math.abs(t.clientY - active.startY);
    if (dx > TAP_MAX_PX || dy > TAP_MAX_PX) {
      active.moved = true;
    }
    if (!active.moved) return;
    // Stop the browser from also scrolling the page / triggering pull-to-
    // refresh. We're handling vertical navigation ourselves.
    if (e.cancelable) e.preventDefault();
    // Swipe up (finger up) → newer content → scroll down (positive).
    // Swipe down → older content → scroll up (negative).
    active.residualPx += active.lastY - t.clientY;
    active.lastY = t.clientY;
    const px = linePx();
    const lines = (active.residualPx / px) | 0;
    if (lines !== 0) {
      term.scrollLines(lines);
      active.residualPx -= lines * px;
    }
  };

  const onEnd = () => {
    if (!active) return;
    const dt = performance.now() - active.startTs;
    const wasTap = !active.moved && dt < TAP_MAX_MS;
    active = null;
    if (wasTap) term.focus();
  };

  const onCancel = () => {
    active = null;
  };

  // touchmove must be non-passive so we can preventDefault when scrolling.
  // touchstart / touchend stay passive — they don't block anything.
  container.addEventListener("touchstart", onStart, { passive: true });
  container.addEventListener("touchmove", onMove, { passive: false });
  container.addEventListener("touchend", onEnd, { passive: true });
  container.addEventListener("touchcancel", onCancel, { passive: true });

  return () => {
    container.removeEventListener("touchstart", onStart);
    container.removeEventListener("touchmove", onMove);
    container.removeEventListener("touchend", onEnd);
    container.removeEventListener("touchcancel", onCancel);
  };
}
