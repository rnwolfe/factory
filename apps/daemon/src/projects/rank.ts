/**
 * Fractional indexing for operator queue ordering (ADR-021 §B).
 *
 * A task's `rank` is a short string key; sorting by it lexicographically gives
 * the operator-defined order. Inserting between two neighbors generates a new
 * key strictly between them, so a reorder rewrites exactly ONE task's rank —
 * never a renumber. Keys are base-62 over `0-9A-Za-z`, whose ASCII order equals
 * digit order, so plain string `<` compares correctly.
 *
 * This is the classic "midpoint" fractional index (per David Greenspan,
 * *Implementing Fractional Indexing*), minus the integer-header optimization —
 * ample for an operator queue of tens of tasks. Keys may lengthen by a char on
 * repeated same-gap inserts; a one-shot re-spacing is the rebalance if they ever
 * get long (not needed at this scale).
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS.charAt(0);

/** A key strictly between `a` and `b` (exclusive). `a < b`; either may be empty. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rank midpoint: ${a} >= ${b}`);
  if (a.endsWith(ZERO) || b?.endsWith(ZERO)) {
    throw new Error("rank midpoint: trailing zero");
  }
  if (b != null) {
    // Copy the longest common prefix, then recurse on the remainder.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0] as string) : 0;
  const digitB = b != null && b !== "" ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
  if (digitB - digitA > 1) {
    const mid = Math.round(0.5 * (digitA + digitB));
    return DIGITS[mid] as string;
  }
  // First digits are consecutive: descend into `b` (if it has more digits) or
  // extend `a` toward the top of the range.
  if (b != null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[digitA] as string) + midpoint(a.slice(1), null);
}

/**
 * Generate a rank key ordered strictly between `a` and `b` (either may be null:
 * `a=null` → before `b`; `b=null` → after `a`; both null → a middle key).
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a != null && b != null && a >= b) throw new Error(`rank: ${a} >= ${b} (not ordered)`);
  if (a == null && b == null) return DIGITS[Math.floor(DIGITS.length / 2)] as string; // "V"
  if (a == null) return midpoint("", b);
  return midpoint(a, b);
}

/** Generate `n` keys evenly ordered between `a` and `b` (for batch inserts). */
export function generateNKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [generateKeyBetween(a, b)];
  // Bisect: place the middle key, then recurse into each half. O(n) keys.
  const mid = generateKeyBetween(a, b);
  const half = Math.floor(n / 2);
  return [
    ...generateNKeysBetween(a, mid, half),
    mid,
    ...generateNKeysBetween(mid, b, n - half - 1),
  ];
}
