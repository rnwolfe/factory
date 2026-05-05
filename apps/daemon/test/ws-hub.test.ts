import { describe, expect, test } from "bun:test";
import { parseScope } from "../src/ws/hub.ts";

describe("parseScope", () => {
  test("parses each known scope kind", () => {
    expect(parseScope("run:abc")).toEqual({ kind: "run", id: "abc" });
    expect(parseScope("project:p123")).toEqual({ kind: "project", id: "p123" });
    expect(parseScope("audit:a-1")).toEqual({ kind: "audit", id: "a-1" });
    expect(parseScope("plan:p-1")).toEqual({ kind: "plan", id: "p-1" });
    expect(parseScope("decision:d-1")).toEqual({ kind: "decision", id: "d-1" });
  });

  test("rejects null/empty/malformed", () => {
    expect(parseScope(null)).toBeNull();
    expect(parseScope("")).toBeNull();
    expect(parseScope("nokind")).toBeNull();
    expect(parseScope(":no-kind")).toBeNull(); // empty kind
    expect(parseScope("run:")).toBeNull(); // empty id
  });

  test("rejects unknown kinds", () => {
    expect(parseScope("idea:x")).toBeNull();
    expect(parseScope("foo:bar")).toBeNull();
  });

  test("preserves a colon inside the id (cuids do not contain colons, but be tolerant)", () => {
    // Right-of-first-colon is the id verbatim; ids should not contain colons in
    // practice, but the parser shouldn't lose data if one slips in.
    expect(parseScope("run:abc:def")).toEqual({ kind: "run", id: "abc:def" });
  });
});
