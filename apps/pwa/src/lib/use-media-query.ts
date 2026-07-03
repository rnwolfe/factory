import { useEffect, useState } from "react";

/**
 * Reactively track a CSS media query. Returns the current match state and
 * updates when the viewport crosses the query boundary.
 *
 * SSR/test-safe: returns `false` when `matchMedia` is unavailable (e.g. in a
 * DOM shim that doesn't implement it). The canonical use is gating a live
 * subscription on whether its CSS-breakpoint-hidden component is actually
 * visible, so exactly one of a desktop/mobile pair does the work.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    // Sync immediately in case the query changed or the viewport moved
    // between the initial render and this effect running.
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
