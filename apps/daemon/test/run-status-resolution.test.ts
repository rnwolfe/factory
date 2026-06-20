import { describe, expect, test } from "bun:test";
import type { FactoryStatus } from "../src/workers/factory-status.ts";
import { runStatusFor } from "../src/workers/runner.ts";

const done: FactoryStatus = { status: "done", summary: "ok", questions: [], acceptance: [] };

describe("runStatusFor — needs_review rescue (task-046)", () => {
  test("parsed done with no unmet acceptance → completed", () => {
    expect(runStatusFor(done, false, { hasCommits: true, exitCode: 0 })).toBe("completed");
  });

  test("null parse + clean exit + commits → needs_review (not failed)", () => {
    expect(runStatusFor(null, false, { hasCommits: true, exitCode: 0 })).toBe("needs_review");
  });

  test("null parse + clean exit + NO commits → failed (honesty contract intact)", () => {
    expect(runStatusFor(null, false, { hasCommits: false, exitCode: 0 })).toBe("failed");
  });

  test("null parse + commits but non-zero exit → failed", () => {
    expect(runStatusFor(null, false, { hasCommits: true, exitCode: 65 })).toBe("failed");
  });

  test("operator abort wins over needs_review even with commits", () => {
    expect(runStatusFor(null, true, { hasCommits: true, exitCode: 0 })).toBe("aborted");
  });

  test("explicit failed status is preserved even with commits", () => {
    const failed: FactoryStatus = { status: "failed", summary: "", questions: [], acceptance: [] };
    expect(runStatusFor(failed, false, { hasCommits: true, exitCode: 0 })).toBe("failed");
  });
});
