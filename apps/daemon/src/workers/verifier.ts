import type { CrossModelVerdict } from "./cross-model.ts";
import type { AcceptanceResult } from "./factory-status.ts";
import type { QualityReport } from "./quality.ts";

/**
 * The Verifier-Coverage Gate (ADR-014, WS C). Computes a per-run verifier-confidence
 * report from signals that already exist, so "is this safe to land unattended?" is a
 * MEASURED score rather than an assumption baked into `finalStatus === "completed"`.
 *
 * Coverage is four-state, not two. `absent` ("nothing checked this") and a hard `fail`
 * both contribute ZERO — a completed run with all signals absent scores 0 and is NOT
 * autonomy-eligible. A `concern` (a validator hedge — "probably ok, a human might want to
 * glance") earns PARTIAL credit: it is not a defect and must not cap an otherwise-clean run
 * below the `high` bar, but it isn't a clean pass either. That distinction is the operational
 * core of "autonomy = verifier coverage" (MM1) — and it keeps advisory hedges out of the
 * actionable-defect / auto-retry path (see `hasActionableDefect`).
 *
 * This module only COMPUTES. It changes no routing — auto-merge still gates on
 * `completed`. Gating on the score is a deliberate follow-up slice (ADR-014 §sequencing).
 */

export type CoverageState = "pass" | "concern" | "fail" | "absent";
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

/**
 * Fraction of its weight a `concern` earns. A validator that hedges "concerns when
 * unsure" (its prompt tells it to, rather than rubber-stamp) is not reporting a defect —
 * so at half credit, acceptance-pass + quality-pass + cross-model-concern = 0.85 still
 * clears the `high` (≥0.8) bar and auto-lands, instead of being capped at 0.7/medium and
 * ground through the retry loop against an advisory it will only re-emit.
 */
const CONCERN_CREDIT = 0.5;

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
  // `pass` earns full weight; `concern` earns partial credit (an advisory hedge, not a
  // defect); `fail` and `absent` earn nothing (both are "no positive coverage"). The
  // fail-vs-absent distinction is for the operator-facing narrative; concern also gates
  // the auto-retry path (`hasActionableDefect`).
  let score = 0;
  for (const s of signals) {
    if (s.state === "pass") score += weights[s.key] ?? 0;
    else if (s.state === "concern") score += (weights[s.key] ?? 0) * CONCERN_CREDIT;
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
  // `concerns` is an advisory hedge ("probably ok, a human should glance"), NOT a defect —
  // partial credit, and deliberately not actionable. Only a hard `fail` is a concrete
  // defect another model found: zero credit, and it drives the auto-retry loop.
  if (v.state === "concerns") {
    return {
      key: "cross-model",
      label: "Cross-model review",
      state: "concern",
      detail:
        `${v.validator} flagged concerns (${Math.round(v.confidence * 100)}%): ${v.reasoning}`.slice(
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

// ── The gate (ADR-014 slice 2): score + blast-radius → auto-land vs review ──

export type BlastRadius = "contained" | "broad";

export interface BlastClassification {
  radius: BlastRadius;
  churn: number;
  files: number;
  reasons: string[];
}

/**
 * Paths where a change is high-consequence / hard to reverse. NOTE: a schema
 * *definition* file (e.g. `schema.ts`) is deliberately NOT here — editing a
 * schema is ordinary, reversible code. The genuinely risky artifact is an
 * *applied* `migrations/` file, which is listed separately; a schema change that
 * generates a migration still trips that, so we hold only when a change is
 * actually disruptive, not merely schema-adjacent.
 */
const RISKY_PATH =
  /(^|\/)(migrations?\/|.*auth|secrets?|Dockerfile|\.env|package(-lock)?\.json|bun\.lock|\.github\/workflows\/)/i;
const CHURN_LIMIT = 400;
const FILE_LIMIT = 15;

/** Classify a unified diff's reversibility/blast-radius from cheap structural signals. */
export function classifyBlastRadius(diff: string): BlastClassification {
  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ") || l.startsWith("--- ")) continue;
    if (l.startsWith("diff --git")) {
      const m = l.match(/ b\/(.+)$/);
      // Exclude Factory's own bookkeeping (`.factory/work/*.md` task files, etc.)
      // from blast classification — it's metadata, not shipped project code, and
      // a task slug like "…-add-auth-…" would otherwise trip the risky-path filter.
      if (m?.[1] && !m[1].startsWith(".factory/")) files.add(m[1]);
      continue;
    }
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  const churn = added + removed;
  const reasons: string[] = [];
  if (churn > CHURN_LIMIT) reasons.push(`large diff (${churn} lines)`);
  if (files.size > FILE_LIMIT) reasons.push(`many files (${files.size})`);
  const risky = [...files].filter((f) => RISKY_PATH.test(f));
  if (risky.length) reasons.push(`risk-sensitive paths (${risky.slice(0, 3).join(", ")})`);
  return { radius: reasons.length ? "broad" : "contained", churn, files: files.size, reasons };
}

/** The subset of a proposed task the plan-time classifier reads. Structurally a
 *  superset-compatible view of `SpecDecompositionTask` (title/estimate/acceptance). */
export interface MilestoneTaskLike {
  title: string;
  estimate: "small" | "medium" | "large";
  acceptance: string[];
}

/** A milestone proposing more than this many tasks is broad — the plan-time
 *  analogue of `FILE_LIMIT` (breadth of change). */
const MILESTONE_TASK_LIMIT = 10;

/**
 * Risk-sensitive TOPICS in a task's prose — the plan-time analogue of
 * `RISKY_PATH`. A milestone that proposes auth / secrets / migration / infra /
 * CI / payment work is broad by consequence even before a line of code exists,
 * exactly as a diff touching those *paths* is. Kept deliberately in lockstep
 * with `RISKY_PATH`'s intent so "risk-sensitive" means one thing across the
 * diff-time and plan-time gates.
 */
const RISKY_TASK_TOPIC =
  /\b(auth\w*|login|oauth|sso|secret|credential|password|token|migration|schema\s+change|dockerfile|docker|deploy\w*|infrastructure|infra|environment\s+variable|payment|billing|encryption|workflows?|ci\/cd|webhook)\b|\.env/i;

/**
 * Classify a milestone DECOMPOSITION (proposed tasks, before any diff exists)
 * with the same `contained` / `broad` vocabulary as `classifyBlastRadius`. The
 * three plan-time signals are the analogues of the diff-time ones: task count ↔
 * file count (`FILE_LIMIT`), a `large` estimate ↔ high churn (`CHURN_LIMIT`),
 * and a risk-sensitive TOPIC ↔ a risk-sensitive PATH (`RISKY_PATH`). Feeds the
 * hands-off milestone auto-confirm gate (`autoPlanNextMilestone`), which shares
 * the ceiling check (`isWithinBlastCeiling`) with the post-run auto-land gate.
 *
 * `churn` is 0 (no diff yet) and `files` carries the task count, so the shared
 * `BlastClassification` shape composes with `isWithinBlastCeiling` unchanged.
 */
export function classifyMilestoneBlastRadius(tasks: MilestoneTaskLike[]): BlastClassification {
  const reasons: string[] = [];
  if (tasks.length > MILESTONE_TASK_LIMIT) reasons.push(`many tasks (${tasks.length})`);
  const large = tasks.filter((t) => t.estimate === "large");
  if (large.length)
    reasons.push(`large-estimate task${large.length > 1 ? "s" : ""} (${large.length})`);
  const risky = tasks.filter((t) =>
    RISKY_TASK_TOPIC.test(`${t.title}\n${t.acceptance.join("\n")}`),
  );
  if (risky.length) {
    reasons.push(
      `risk-sensitive topics (${risky
        .slice(0, 3)
        .map((t) => t.title)
        .join(", ")})`,
    );
  }
  return { radius: reasons.length ? "broad" : "contained", churn: 0, files: tasks.length, reasons };
}

/**
 * Is a classified blast radius within the operator's ceiling? Broad work needs a
 * `broad` ceiling; contained work always fits. One definition, shared by the
 * post-run auto-land gate (`decideAutoLand`) and the plan-time milestone
 * auto-confirm gate — so "within blast radius" means the same thing in both.
 */
export function isWithinBlastCeiling(radius: BlastRadius, ceiling: BlastRadius): boolean {
  return radius !== "broad" || ceiling === "broad";
}

export interface GateDecision {
  land: boolean;
  reason: string;
}

const LEVEL_RANK: Record<VerifierLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Does an actual coverage level meet (≥) the required minimum? */
export function meetsLevel(actual: VerifierLevel, min: VerifierLevel): boolean {
  return LEVEL_RANK[actual] >= LEVEL_RANK[min];
}

/**
 * The auto-land decision: a run lands unattended only when its verifier coverage
 * meets the project's `minLevel` bar (default `high`) AND its diff is within the
 * project's `maxBlastRadius` ceiling. Anything less routes to `review`. Conservative
 * on purpose — auto-landing unverified changes is the most dangerous surface in the
 * system.
 *
 * `maxBlastRadius` (the project's resolved `gate.maxBlastRadius`, ADR-016) is the
 * operator's opt-in: `"contained"` (default) holds broad diffs for review;
 * `"broad"` lets an operator who trusts a project auto-land even risk-sensitive /
 * large diffs (still requiring the coverage bar). Defaults to `"contained"` so any
 * caller that doesn't pass it keeps the strict behavior.
 *
 * `minLevel` (the project's resolved `gate.minLevel`, ADR-016) is the coverage bar:
 * `"high"` (default) is the strict baseline; a project the operator trusts can lower
 * it to `"medium"` to auto-land partially-verified work. Defaults to `"high"` so any
 * caller that doesn't pass it keeps the strict behavior.
 */
export function decideAutoLand(
  report: VerifierReport,
  blast: BlastClassification,
  maxBlastRadius: BlastRadius = "contained",
  minLevel: VerifierLevel = "high",
): GateDecision {
  if (!meetsLevel(report.level, minLevel)) {
    return { land: false, reason: `verifier coverage ${report.level} (need ${minLevel})` };
  }
  if (!isWithinBlastCeiling(blast.radius, maxBlastRadius)) {
    return { land: false, reason: `broad blast radius — ${blast.reasons.join("; ")}` };
  }
  return { land: true, reason: `${report.level} verifier coverage + ${blast.radius} diff` };
}

/**
 * True when the report has ≥1 signal the agent can FIX on retry — a real `fail`
 * (cross-model defect, failed acceptance, failing quality check). An `absent`
 * signal is a coverage gap a retry can't conjure away, so absent-only holds are
 * NOT actionable and should surface for the operator instead of auto-retrying.
 */
export function hasActionableDefect(report: VerifierReport): boolean {
  return report.signals.some((s) => s.state === "fail");
}

/**
 * Render the gate's failing signals as authoritative retry feedback — injected
 * into a retry's prompt (as operator-context) so the agent fixes the concrete
 * cross-model / acceptance / quality defect instead of re-running blind. Shared
 * by the operator-driven blocked_run retry and the L3 auto-retry loop.
 */
export function renderVerifierFindings(report: VerifierReport | null | undefined): string {
  if (!report) return "";
  const failing = report.signals.filter(
    (s) => s.state === "fail" || s.state === "absent" || s.state === "concern",
  );
  if (failing.length === 0) return "";
  const lines = failing.map((s) => {
    const verb = s.state === "fail" ? "FAILED" : s.state === "concern" ? "FLAGGED" : "MISSING";
    return `- **${s.label} — ${verb}.** ${s.detail}`;
  });
  return `## Verifier gate held your prior run (coverage: ${report.level})

Your prior run completed but the verifier gate held it for review. Resolve the
signals below to raise coverage before completing. A cross-model **FAIL** is a concrete
defect another model found in your diff; treat it as authoritative and fix it. A
**FLAGGED** signal is an advisory concern (address it if quick, but it is not a hard
defect). A **MISSING** signal is a coverage gap (e.g. no testable acceptance criteria).

${lines.join("\n")}`;
}
