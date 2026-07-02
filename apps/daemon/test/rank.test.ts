import { describe, expect, test } from "bun:test";
import { generateKeyBetween, generateNKeysBetween } from "../src/projects/rank.ts";

describe("generateKeyBetween — ordering invariant", () => {
  test("both null → a non-empty middle key", () => {
    const k = generateKeyBetween(null, null);
    expect(k.length).toBeGreaterThan(0);
    expect(k.endsWith("0")).toBe(false);
  });

  test("append (b=null) strictly increases", () => {
    let prev = generateKeyBetween(null, null);
    for (let i = 0; i < 200; i++) {
      const next = generateKeyBetween(prev, null);
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  test("prepend (a=null) strictly decreases", () => {
    let next = generateKeyBetween(null, null);
    for (let i = 0; i < 200; i++) {
      const prev = generateKeyBetween(null, next);
      expect(prev < next).toBe(true);
      next = prev;
    }
  });

  test("insert between two neighbors lands strictly between — repeatedly", () => {
    const lo = generateKeyBetween(null, null);
    let hi = generateKeyBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = generateKeyBetween(lo, hi);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      // Keep squeezing the same gap — the pathological case for fractional keys.
      hi = mid;
    }
  });

  test("rejects out-of-order bounds", () => {
    expect(() => generateKeyBetween("b", "a")).toThrow();
  });

  test("a full random-ish insert sequence stays globally sorted", () => {
    // Build a list by inserting at head, tail, and middle; assert sorted order
    // matches insertion intent at each step.
    const keys: string[] = [generateKeyBetween(null, null)];
    for (let i = 0; i < 100; i++) {
      const pos = (i * 37) % (keys.length + 1); // deterministic spread
      const a = pos > 0 ? keys[pos - 1]! : null;
      const b = pos < keys.length ? keys[pos]! : null;
      const k = generateKeyBetween(a, b);
      keys.splice(pos, 0, k);
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted); // insertion order already sorted
    expect(new Set(keys).size).toBe(keys.length); // all unique
  });
});

describe("generateNKeysBetween", () => {
  test("returns n strictly increasing keys between the bounds", () => {
    const keys = generateNKeysBetween(null, null, 20);
    expect(keys.length).toBe(20);
    for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
  });

  test("keys fit strictly inside given bounds", () => {
    const lo = generateKeyBetween(null, null);
    const hi = generateKeyBetween(lo, null);
    const keys = generateNKeysBetween(lo, hi, 8);
    expect(keys.length).toBe(8);
    expect(keys[0]! > lo).toBe(true);
    expect(keys[7]! < hi).toBe(true);
    for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
  });

  test("n<=0 → empty", () => {
    expect(generateNKeysBetween(null, null, 0)).toEqual([]);
  });
});
