/**
 * Unit tests for the pull-to-refresh damping curve.
 *
 * The gesture wiring itself (touch listeners, scroll-at-top gating) is
 * exercised on-device; here we pin the pure `resist` curve that turns raw
 * finger travel into the rubber-band offset, since the trigger feel depends
 * on it staying monotonic, bounded, and zero-at-rest.
 */

import { describe, expect, test } from "bun:test";
import { resist } from "../use-pull-to-refresh.ts";

describe("resist", () => {
  test("no offset for non-positive travel", () => {
    expect(resist(0, 110)).toBe(0);
    expect(resist(-50, 110)).toBe(0);
  });

  test("is bounded by max — the rubber-band never runs away", () => {
    // A realistic long drag stays under the cap...
    expect(resist(300, 110)).toBeLessThan(110);
    expect(resist(300, 110)).toBeGreaterThan(100);
    // ...and even an absurd one never exceeds it.
    expect(resist(10_000, 110)).toBeLessThanOrEqual(110);
  });

  test("is strictly increasing in travel", () => {
    let prev = -1;
    for (let d = 0; d <= 400; d += 20) {
      const v = resist(d, 110);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  test("applies resistance — damped offset trails raw travel", () => {
    // At 96px of raw travel the damped offset is ~64px (the trigger), i.e.
    // the operator must pull noticeably past the trigger distance.
    expect(resist(96, 110)).toBeGreaterThan(60);
    expect(resist(96, 110)).toBeLessThan(96);
  });
});
