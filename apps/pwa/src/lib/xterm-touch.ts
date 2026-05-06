import type { Terminal } from "@xterm/xterm";

/**
 * Wire vertical touch swipes on `container` to xterm scrollback navigation.
 *
 * xterm's `.xterm-viewport` is a native-scroll element behind the screen
 * layer, but on mobile the screen layer (canvas / DOM cells) absorbs touch
 * events without translating them into viewport scroll. The result: the
 * operator can't drag through scrollback on a phone.
 *
 * This handler reads touchmove deltas and calls `term.scrollLines` so a
 * one-finger pan scrolls the buffer the way the operator expects. Listeners
 * are passive — we don't block native gestures (browser pinch-zoom, multi-
 * finger gestures still work).
 *
 * Returns a cleanup that removes the listeners. Safe to call repeatedly.
 */
export function wireXtermTouchScroll(term: Terminal, container: HTMLElement): () => void {
  let lastY: number | null = null;
  let residualPx = 0;

  // Pixel-per-line approximation. xterm.options.fontSize is the cap height,
  // not the cell height, but lineHeight is a multiplier; the product is a
  // sane default. Underestimating slightly is fine — scrolls feel snappier.
  const linePx = () => {
    const fs = term.options.fontSize ?? 12.5;
    const lh = term.options.lineHeight ?? 1.2;
    return Math.max(8, fs * lh);
  };

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      lastY = null;
      return;
    }
    lastY = e.touches[0]?.clientY ?? null;
    residualPx = 0;
  };

  const onMove = (e: TouchEvent) => {
    if (lastY === null) return;
    if (e.touches.length !== 1) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    // Swipe up (finger moves up) → reveal newer content → scroll down (positive lines).
    // Swipe down → reveal older content → scroll up (negative lines).
    residualPx += lastY - y;
    lastY = y;
    const px = linePx();
    const lines = (residualPx / px) | 0;
    if (lines !== 0) {
      term.scrollLines(lines);
      residualPx -= lines * px;
    }
  };

  const onEnd = () => {
    lastY = null;
    residualPx = 0;
  };

  container.addEventListener("touchstart", onStart, { passive: true });
  container.addEventListener("touchmove", onMove, { passive: true });
  container.addEventListener("touchend", onEnd, { passive: true });
  container.addEventListener("touchcancel", onEnd, { passive: true });

  return () => {
    container.removeEventListener("touchstart", onStart);
    container.removeEventListener("touchmove", onMove);
    container.removeEventListener("touchend", onEnd);
    container.removeEventListener("touchcancel", onEnd);
  };
}
