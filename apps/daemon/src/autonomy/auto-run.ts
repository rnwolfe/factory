import type { AutonomyConfig } from "./config.ts";

/**
 * The Phase C auto-run eligibility gate (ADR-017). A pure predicate over what's
 * knowable at PROPOSAL time — the universal gates (kill-switch, enabled, top-rung,
 * class allow-list, per-tick budget) plus the code-run quality requirement. The
 * remaining ADR-017 gates (frozen acceptance, post-run blast-radius) are enforced
 * downstream by the existing pipeline (the freeze precondition + the verifier gate),
 * so they aren't re-checked here. This is where the safety conjunction lives —
 * heavily tested, no side effects.
 */

export interface AutoRunCandidate {
  /** The proposal kind, e.g. "groom-backlog" | "adopt-as-task". */
  proposalClass: string;
  /** Does promoting this proposal produce a code-changing RUN (vs a reversible action)? */
  isCodeRun: boolean;
  /** The project's current (earned) ladder state. */
  projectAutonomyMode: "collaborative" | "autonomous";
  /** Whether the project has a configured quality gate (quality.yaml present). */
  hasQualityGate: boolean;
  /** Auto-runs already executed for this project in the current Watch tick. */
  runsThisTick: number;
}

export interface AutoRunVerdict {
  eligible: boolean;
  /** Why — for the audit trail / event detail, whether eligible or not. */
  reason: string;
}

function no(reason: string): AutoRunVerdict {
  return { eligible: false, reason };
}

export function isAutoRunEligible(c: AutoRunCandidate, cfg: AutonomyConfig): AutoRunVerdict {
  const a = cfg.autorun;
  // Universal gates — the conjunction, ordered cheap-first.
  if (a.emergencyStop) return no("emergency stop engaged");
  if (!a.enabled) return no("auto-run disabled for this project");
  if (c.projectAutonomyMode !== "autonomous") return no("project is not at the top trust rung");
  if (!a.classes.includes(c.proposalClass)) {
    return no(`class "${c.proposalClass}" is not in the auto-run allow-list`);
  }
  if (c.runsThisTick >= a.maxPerTick) {
    return no(`per-tick auto-run budget exhausted (${a.maxPerTick})`);
  }
  // Code-run-only gate: a configured quality gate is required so the verifier can
  // actually reach `high` (else the gate would always hold the run anyway).
  if (c.isCodeRun && a.requireQualityGate && !c.hasQualityGate) {
    return no("code-run auto-run requires a configured quality gate (quality.yaml)");
  }
  return { eligible: true, reason: "all auto-run gates passed" };
}
