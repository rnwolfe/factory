import { describe, expect, test } from "bun:test";
import { ensureAcceptanceSection } from "../src/projects/tasks.ts";

describe("ensureAcceptanceSection", () => {
  test("appends an Acceptance section when the body has none", () => {
    const out = ensureAcceptanceSection("## Notes\n\nCaptured from audit.");
    expect(out).toContain("## Notes");
    expect(out).toMatch(/## Acceptance\n\n- \[ \] \(TBD\)/);
  });

  test("is a no-op when an Acceptance heading already exists", () => {
    const body = "Do the thing.\n\n## Acceptance\n\n- [ ] it works\n";
    expect(ensureAcceptanceSection(body)).toBe(body);
  });

  test("matches the heading case-insensitively at any level", () => {
    const body = "x\n\n### acceptance\n\n- [ ] y";
    expect(ensureAcceptanceSection(body)).toBe(body);
  });

  test("handles an empty / undefined body", () => {
    expect(ensureAcceptanceSection(undefined)).toBe("## Acceptance\n\n- [ ] (TBD)\n");
    expect(ensureAcceptanceSection("")).toBe("## Acceptance\n\n- [ ] (TBD)\n");
  });

  test("does not false-match a mid-line mention of acceptance", () => {
    const out = ensureAcceptanceSection("We discussed acceptance criteria informally.");
    expect(out).toMatch(/## Acceptance/);
  });
});
