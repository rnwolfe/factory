import { describe, expect, test } from "bun:test";
import { wrapPrompt, wrapResumePrompt } from "../src/workers/factory-status.ts";

/**
 * Regression guard for the systemic "acceptance always absent" bug: plain task
 * files (feature-plan tasks, ad-hoc tasks) run via wrapPrompt, whose footer never
 * requested the structured `acceptance` array — so the verifier saw 0 criteria and
 * held every autonomous run. The base footer must now request it for all runs.
 */
const TASK = "Build the thing.\n\n## Acceptance\n\n- [ ] A test asserts X\n";

describe("completion footer requests acceptance for plain tasks", () => {
  test("wrapPrompt instructs the agent to populate `acceptance`", () => {
    const out = wrapPrompt(TASK, "autonomous");
    expect(out).toContain("acceptance");
    expect(out).toContain("Populate `acceptance`");
    // the JSON schema example carries the criterion/met/evidence shape
    expect(out).toContain('"met"');
    // and the task's own criteria are still in the prompt
    expect(out).toContain("A test asserts X");
  });

  test("collaborative runs request it too (informational coverage)", () => {
    expect(wrapPrompt(TASK, "collaborative")).toContain("Populate `acceptance`");
  });

  test("the resume path also requests acceptance", () => {
    expect(wrapResumePrompt(TASK, "autonomous")).toContain("Populate `acceptance`");
  });
});
