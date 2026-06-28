import { describe, expect, test } from "bun:test";
import type { AcceptanceResult } from "../src/workers/factory-status.ts";
import type { QualityReport } from "../src/workers/quality.ts";
import { computeVerifierReport } from "../src/workers/verifier.ts";

const met = (n: number): AcceptanceResult[] =>
  Array.from({ length: n }, (_, i) => ({ criterion: `c${i}`, met: true }));

const quality = (overall: QualityReport["overall"], n = 1): QualityReport => ({
  ranAt: 1,
  overall,
  results: Array.from({ length: n }, (_, i) => ({
    name: `q${i}`,
    command: "x",
    exitCode: overall === "fail" ? 1 : 0,
    durationMs: 1,
    stdoutTail: "",
    stderrTail: "",
    timedOut: false,
  })),
});

function sig(r: ReturnType<typeof computeVerifierReport>, key: string) {
  return r.signals.find((s) => s.key === key);
}

describe("computeVerifierReport", () => {
  test("acceptance met + quality green → full coverage (high)", () => {
    const r = computeVerifierReport({ acceptance: met(3), qualityReport: quality("pass") });
    expect(r.score).toBe(1);
    expect(r.level).toBe("high");
    expect(sig(r, "acceptance")?.state).toBe("pass");
    expect(sig(r, "quality")?.state).toBe("pass");
  });

  test("acceptance met, no quality config → partial (medium, 0.6)", () => {
    const r = computeVerifierReport({ acceptance: met(2), qualityReport: quality("skipped", 0) });
    expect(r.score).toBe(0.6);
    expect(r.level).toBe("medium");
    expect(sig(r, "quality")?.state).toBe("absent");
  });

  test("no acceptance criteria, quality green → low (0.4)", () => {
    const r = computeVerifierReport({ acceptance: [], qualityReport: quality("pass") });
    expect(r.score).toBe(0.4);
    expect(r.level).toBe("low");
    expect(sig(r, "acceptance")?.state).toBe("absent");
  });

  test("completed but NOTHING checked it → score 0 / none (the dangerous case)", () => {
    const r = computeVerifierReport({ acceptance: [], qualityReport: null });
    expect(r.score).toBe(0);
    expect(r.level).toBe("none");
    expect(sig(r, "acceptance")?.state).toBe("absent");
    expect(sig(r, "quality")?.state).toBe("absent");
  });

  test("an unmet acceptance criterion → fail (no positive coverage from it)", () => {
    const acceptance: AcceptanceResult[] = [
      { criterion: "a", met: true },
      { criterion: "b", met: false, reason: "missing" },
    ];
    const r = computeVerifierReport({ acceptance, qualityReport: quality("pass") });
    expect(sig(r, "acceptance")?.state).toBe("fail");
    expect(r.score).toBe(0.4); // only quality contributes
    expect(r.level).toBe("low");
  });

  test("quality failed → fail state, contributes nothing", () => {
    const r = computeVerifierReport({ acceptance: met(1), qualityReport: quality("fail") });
    expect(sig(r, "quality")?.state).toBe("fail");
    expect(r.score).toBe(0.6); // only acceptance contributes
  });

  test("cross-model undefined → excluded (2-signal weighting, no cap)", () => {
    const r = computeVerifierReport({ acceptance: met(1), qualityReport: quality("pass") });
    expect(r.signals.find((s) => s.key === "cross-model")).toBeUndefined();
    expect(r.score).toBe(1); // not capped by a missing 3rd signal
  });

  test("cross-model pass → 3-signal weighting, full coverage", () => {
    const r = computeVerifierReport({
      acceptance: met(1),
      qualityReport: quality("pass"),
      crossModel: { validator: "codex", state: "pass", confidence: 0.9, reasoning: "clean" },
    });
    expect(sig(r, "cross-model")?.state).toBe("pass");
    expect(r.score).toBe(1); // 0.4 + 0.3 + 0.3
    expect(r.level).toBe("high");
  });

  test("cross-model ran but no verdict (null) → absent, lowers the score", () => {
    const r = computeVerifierReport({
      acceptance: met(1),
      qualityReport: quality("pass"),
      crossModel: null,
    });
    expect(sig(r, "cross-model")?.state).toBe("absent");
    expect(r.score).toBe(0.7); // 0.4 + 0.3 + 0 (cross-model absent)
  });

  test("cross-model concerns/fail → fail signal, no positive coverage", () => {
    const r = computeVerifierReport({
      acceptance: met(1),
      qualityReport: quality("pass"),
      crossModel: {
        validator: "claude-code",
        state: "concerns",
        confidence: 0.4,
        reasoning: "risky",
      },
    });
    expect(sig(r, "cross-model")?.state).toBe("fail");
    expect(r.score).toBe(0.7);
  });
});
