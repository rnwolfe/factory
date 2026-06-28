/**
 * Pure helpers for the autonomy/ops metric charts (ADR-013). The time-series
 * API (`metrics.series`) returns sparse `{ date, value }[]` rows (only days that
 * have a value); these helpers turn one or more such series into the
 * date-keyed, gap-filled rows Recharts wants — and compute the derived ratios
 * (decisions-per-run, auto-ratify rate) the north-star tracks. Kept free of
 * React/Recharts so they're cheap to unit-test.
 */

export interface SeriesPoint {
  date: string;
  value: number;
}

/** "YYYY-MM-DD" in UTC — the granularity the rollup writes. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Inclusive [from, to] bounds for a trailing window of `days` ending today
 * (UTC). `days = 30` → 30 calendar days inclusive of today.
 */
export function rangeBounds(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = ymd(now);
  const from = ymd(new Date(now.getTime() - (days - 1) * 86_400_000));
  return { from, to };
}

export function seriesToMap(rows: SeriesPoint[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows ?? []) m.set(r.date, r.value);
  return m;
}

/** Sorted union of the dates present across every map. */
export function unionDates(...maps: Array<Map<string, number>>): string[] {
  const set = new Set<string>();
  for (const m of maps) for (const k of m.keys()) set.add(k);
  return [...set].sort();
}

/**
 * Per-day ratio of `numerator ÷ denominator`, guarding divide-by-zero (a day
 * with zero runs reads 0, not NaN/∞). Used for both decisions-per-run and the
 * auto-ratify rate.
 */
export function ratioSeries(
  numerator: SeriesPoint[] | undefined,
  denominator: SeriesPoint[] | undefined,
): ChartRow[] {
  const num = seriesToMap(numerator);
  const den = seriesToMap(denominator);
  return unionDates(num, den).map((date) => {
    const d = den.get(date) ?? 0;
    const n = num.get(date) ?? 0;
    return { date, value: d > 0 ? n / d : 0 };
  });
}

/**
 * A Recharts row: a `date` plus any number of numeric columns. The index
 * signature is `number | string` so `date` (a string) coexists with the
 * plotted numeric series under one type.
 */
export interface ChartRow {
  date: string;
  [key: string]: number | string;
}

/**
 * Merge several named series into one row-per-date table for a multi-series
 * chart. Missing values fill as 0 so stacked areas and lines stay continuous.
 */
export function mergeSeries(
  named: Array<{ key: string; rows: SeriesPoint[] | undefined }>,
): ChartRow[] {
  const maps = named.map((n) => ({ key: n.key, map: seriesToMap(n.rows) }));
  const dates = unionDates(...maps.map((m) => m.map));
  return dates.map((date) => {
    const row: ChartRow = { date };
    for (const m of maps) row[m.key] = m.map.get(date) ?? 0;
    return row;
  });
}

/** True when every row's value is 0 (or there are no rows) — drives empty UI. */
export function isAllZero(rows: SeriesPoint[] | undefined): boolean {
  if (!rows || rows.length === 0) return true;
  return rows.every((r) => r.value === 0);
}

/** True when every value of every keyed column is 0 — empty state for charts. */
export function rowsAllZero(rows: ChartRow[], keys: string[]): boolean {
  if (rows.length === 0) return true;
  return rows.every((row) => keys.every((k) => Number(row[k] ?? 0) === 0));
}
