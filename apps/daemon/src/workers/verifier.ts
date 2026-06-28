import type { CrossModelVerdict } from "./cross-model.ts";
import type { AcceptanceResult } from "./factory-status.ts";
import type { QualityReport } from "./quality.ts";

/**
 * The Verifier-Coverage Gate (ADR-014, WS C). Computes a per-run verifier-confidence
 * report from signals that already exist, so "is this safe to land unattended?" is a
 * MEASURED score rather than an assumption baked into `finalStatus === "completed"`.
 *
 * Coverage is three-state, not two: `absent` ("nothing checked this") contributes ZERO
 * — a completed run with all signals absent scores 0 and is NOT autonomy-eligible. That
 * three-way distinction is the operational core of "autonomy = verifier coverage" (MM1).
 *
 * This module only COMPUTES. It changes no routing — auto-merge still gates on
 * `completed`. Gating on the score is a deliberate follow-up slice (ADR-014 §sequencing).
 */

export type CoverageState = "pass" | "fail" | "absent";
export type VerifierLevel = "none" | "low" | "medium" | "high";

export interface VerifierSignal {
  key: "acceptance" | "quality" | "cross-model";
  label: string;
  state: CoverageState;
  detail: string;
}

export interface VerifierReport {
  /** Weighted coverage, 0..1. */
  score: number;
  level: VerifierLevel;
  signals: VerifierSignal[];
}

// Weights with and without cross-model. When cross-model wasn't run we score over
// acceptance+quality only (and renormalize) — disabling it must not artificially cap
// the score. When it WAS run, it carries real weight as the strongest signal.
const WEIGHTS_2: Record<string, number> = { acceptance: 0.6, quality: 0.4 };
const WEIGHTS_3: Record<string, number> = { acceptance: 0.4, quality: 0.3, "cross-model": 0.3 };

export interface VerifierInput {
  acceptance: AcceptanceResult[];
  qualityReport: QualityReport | null;
  /**
   * `undefined` = cross-model not run (excluded from the score); `null` = it ran but
   * produced no verdict (counts as `absent`); a verdict = pass/concerns/fail.
   */
  crossModel?: CrossModelVerdict | null;
}

export function computeVerifierReport(input: VerifierInput): VerifierReport {
  const signals: VerifierSignal[] = [
    acceptanceSignal(input.acceptance),
    qualitySignal(input.qualityReport),
  ];
  const includeCrossModel = input.crossModel !== undefined;
  if (includeCrossModel) signals.push(crossModelSignal(input.crossModel ?? null));

  const weights = includeCrossModel ? WEIGHTS_3 : WEIGHTS_2;
  // `pass` earns its weight; `fail` and `absent` earn nothing (both are "no positive
  // coverage" — the state distinction is for the operator-facing narrative).
  let score = 0;
  for (const s of signals) {
    if (s.state === "pass") score += weights[s.key] ?? 0;
  }
  score = Math.round(score * 100) / 100;
  return { score, level: levelFor(score), signals };
}

function crossModelSignal(v: CrossModelVerdict | null): VerifierSignal {
  if (!v) {
    return {
      key: "cross-model",
      label: "Cross-model review",
      state: "absent",
      detail: "Cross-model validation produced no verdict.",
    };
  }
  if (v.state === "pass") {
    return {
      key: "cross-model",
      label: "Cross-model review",
      state: "pass",
      detail: `${v.validator} validated (${Math.round(v.confidence * 100)}%): ${v.reasoning}`.slice(
        0,
        200,
      ),
    };
  }
  return {
    key: "cross-model",
    label: "Cross-model review",
    state: "fail",
    detail: `${v.validator} raised ${v.state}: ${v.reasoning}`.slice(0, 200),
  };
}

function acceptanceSignal(acceptance: AcceptanceResult[]): VerifierSignal {
  if (acceptance.length === 0) {
    return {
      key: "acceptance",
      label: "Acceptance criteria",
      state: "absent",
      detail: "No testable acceptance criteria — nothing checked the work's intent.",
    };
  }
  const unmet = acceptance.filter((a) => !a.met);
  if (unmet.length > 0) {
    return {
      key: "acceptance",
      label: "Acceptance criteria",
      state: "fail",
      detail: `${unmet.length}/${acceptance.length} criteria unmet.`,
    };
  }
  return {
    key: "acceptance",
    label: "Acceptance criteria",
    state: "pass",
    detail: `All ${acceptance.length} criteria met.`,
  };
}

function qualitySignal(q: QualityReport | null): VerifierSignal {
  if (!q || q.overall === "skipped") {
    return {
      key: "quality",
      label: "Quality checks",
      state: "absent",
      detail: "No quality checks configured for this project.",
    };
  }
  if (q.overall === "fail") {
    return {
      key: "quality",
      label: "Quality checks",
      state: "fail",
      detail: "One or more quality checks failed.",
    };
  }
  return {
    key: "quality",
    label: "Quality checks",
    state: "pass",
    detail: `${q.results.length} check(s) passed.`,
  };
}

function levelFor(score: number): VerifierLevel {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  if (score > 0) return "low";
  return "none";
}
