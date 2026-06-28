import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  isAllZero,
  mergeSeries,
  rangeBounds,
  ratioSeries,
  rowsAllZero,
  seriesToMap,
  unionDates,
} from "../../lib/metric-series.ts";
import { MetricChart } from "../metric-chart.tsx";

afterEach(() => {
  cleanup();
});

describe("metric-series helpers", () => {
  test("ratioSeries guards divide-by-zero and aligns dates", () => {
    const decisions = [
      { date: "2026-06-01", value: 4 },
      { date: "2026-06-02", value: 0 },
    ];
    const runs = [
      { date: "2026-06-01", value: 2 },
      { date: "2026-06-02", value: 0 }, // zero runs → ratio 0, never NaN/Infinity
    ];
    expect(ratioSeries(decisions, runs)).toEqual([
      { date: "2026-06-01", value: 2 },
      { date: "2026-06-02", value: 0 },
    ]);
  });

  test("ratioSeries unions dates across sparse inputs", () => {
    const num = [{ date: "2026-06-02", value: 3 }];
    const den = [{ date: "2026-06-01", value: 1 }];
    const out = ratioSeries(num, den);
    expect(out.map((r) => r.date)).toEqual(["2026-06-01", "2026-06-02"]);
    expect(out[0]?.value).toBe(0); // no numerator that day
    expect(out[1]?.value).toBe(0); // no denominator that day
  });

  test("mergeSeries fills gaps with 0 across keys", () => {
    const rows = mergeSeries([
      { key: "loc_added", rows: [{ date: "2026-06-01", value: 10 }] },
      { key: "loc_removed", rows: [{ date: "2026-06-02", value: 5 }] },
    ]);
    expect(rows).toEqual([
      { date: "2026-06-01", loc_added: 10, loc_removed: 0 },
      { date: "2026-06-02", loc_added: 0, loc_removed: 5 },
    ]);
  });

  test("rangeBounds is inclusive of today and (days-1) back", () => {
    const now = new Date("2026-06-28T12:00:00Z");
    expect(rangeBounds(7, now)).toEqual({ from: "2026-06-22", to: "2026-06-28" });
    expect(rangeBounds(1, now)).toEqual({ from: "2026-06-28", to: "2026-06-28" });
  });

  test("empty detectors treat missing / all-zero as empty", () => {
    expect(isAllZero(undefined)).toBe(true);
    expect(isAllZero([])).toBe(true);
    expect(isAllZero([{ date: "x", value: 0 }])).toBe(true);
    expect(isAllZero([{ date: "x", value: 1 }])).toBe(false);
    expect(rowsAllZero([{ date: "x", a: 0, b: 0 }], ["a", "b"])).toBe(true);
    expect(rowsAllZero([{ date: "x", a: 0, b: 2 }], ["a", "b"])).toBe(false);
  });

  test("seriesToMap / unionDates round-trip", () => {
    const m = seriesToMap([{ date: "2026-06-01", value: 9 }]);
    expect(m.get("2026-06-01")).toBe(9);
    expect(unionDates(m, seriesToMap([{ date: "2026-06-03", value: 1 }]))).toEqual([
      "2026-06-01",
      "2026-06-03",
    ]);
  });
});

describe("MetricChart", () => {
  const series = [{ key: "value", label: "decisions/run", color: "var(--color-accent)" }];

  test("renders the empty placeholder when flagged empty", () => {
    const { container } = render(
      <MetricChart data={[]} series={series} empty emptyLabel="no runs yet" />,
    );
    expect(container.textContent).toContain("no runs yet");
  });

  test("renders the empty placeholder when data is absent regardless of flag", () => {
    const { container } = render(<MetricChart data={[]} series={series} />);
    expect(container.textContent).toContain("no data in this range yet");
  });

  test("renders a chart (not the placeholder) when data is present", () => {
    const data = [
      { date: "2026-06-01", value: 2 },
      { date: "2026-06-02", value: 1 },
    ];
    const { container } = render(<MetricChart data={data} series={series} />);
    // The placeholder copy is absent → the chart path (ResponsiveContainer)
    // rendered instead. (Recharts draws no SVG at 0px in the test DOM, so we
    // assert on the branch taken, not on chart internals.)
    expect(container.textContent).not.toContain("no data in this range yet");
    expect(container.getElementsByTagName("div").length).toBeGreaterThan(0);
  });
});
