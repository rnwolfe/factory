# ADR-017 · Phase C — gated auto-run (the autonomy endgame)

**Status:** accepted (2026-06-28) — operator-reviewed; resolutions recorded below.
**Scope:** ADR-011 Phase C / ADR-012 L4 / ADR-016 Slice 5 — the auto-run half of the
autonomy thesis: self-generated work executing without the operator.
**Builds on (hard prerequisites, all shipped):** WS C verifier gate (ADR-014), the
Trust Ladder auto-movement (ADR-012 Slice 2), autonomy config + event log + alerts
(ADR-016). This ADR is intentionally separate because **auto-executing self-generated
work is the most dangerous surface in the system.**

## Context

Everything upstream is built and live: The Watch *generates* typed work; the verifier
gate decides *auto-land vs review*; the Trust Ladder *moves itself*; the autonomy config
*gates* and the event log *tracks + alerts*. The one thing still requiring the operator is
the **submit**: a Watch proposal lands in the inbox and a human approves it into a run.

Phase C closes the loop — for a *narrow, opt-in, gate-proven* class, the submit happens
automatically. This is where decisions-per-run finally approaches 0. It is also the point
of no return if done carelessly: an unattended generate→run→merge loop with a bad gate is
how you wake up to 40 bad commits. The whole design is **conservatism + reversibility +
kill-switches**, leaning on the gates that already exist rather than new trust.

## Decision

A Watch proposal **auto-submits a run** (instead of surfacing for approval) **only when
every one of these holds** — the conjunction is the safety:

1. **`autorun.enabled` for the project** (ADR-016; default **off**, explicit opt-in).
2. **Project is at the top rung** (autonomous) — earned, and it auto-contracts on any failure.
3. **Proposal class ∈ `autorun.classes`** — the operator's allow-list of *which kinds* may
   auto-run (default **empty** = nothing, even when enabled). Start with the single safest
   class (see §"class taxonomy").
4. **The materialized task carries testable acceptance criteria** (WS C slice-3 precondition)
   — no checkable criteria → not auto-run-eligible, it surfaces.
5. **Estimated blast-radius ≤ `autorun.maxBlastRadius`** — a coarse pre-run estimate from the
   proposal's touched-paths/scope; the *actual* diff is still gated post-run.
6. **The auto-run budget for this cadence isn't exhausted** (loop bound, §"loop bounds").
7. **The global kill-switch is off** (a system `autorun.emergencyStop` — one flip halts all
   auto-run portfolio-wide).

When all hold: materialize the task → auto-submit the run → it flows through the **existing**
pipeline unchanged: the verifier gate auto-lands (high + contained) or downgrades to
`needs_review`, and the Trust Ladder contracts on failure. Auto-run adds **no new merge or
execution path** — it only removes the human from the *submit*, behind seven gates.

Every auto-run emits `auto_ran` (push) at start and rides the existing `auto_merged` /
`gate_held` / `trust_contracted` events — so the operator is *told* immediately and can watch
or stop. Surface-first, always.

## Class taxonomy (start tiny)

Not all Watch proposals are auto-run-eligible. Ranked by safety:
- **`groom-backlog`** (close a stale task) — not even a code run; a reversible status flip.
  *The natural first `autorun.classes` member* — lets the loop prove itself on something
  that can't break a build.
- **`adopt-as-task` for a bug with frozen acceptance** — a contained fix, gate-checked.
  *Second.*
- **`draft-feature-plan`** — **never auto-runs.** Features need the freeze gate + vision
  filter (operator judgment); they always surface.
- **`propose-audit` / `propose-project`** — read-mostly / whole-new-thing; surface.

## Loop bounds (the thing that prevents the 40-bad-commits morning)

- **Per-cadence auto-run cap** per project (e.g. ≤ N auto-runs per Watch tick).
- **No re-generation recursion:** work auto-run in a tick cannot itself spawn auto-runs in
  the same tick (the generation→run→generation depth is 1).
- **Contraction is the circuit breaker:** the first failure/merge-conflict contracts the
  project off the top rung (ADR-012), which *by construction* disables auto-run (gate 2) until
  the operator re-promotes. One bad run stops the loop automatically.
- **Kill-switch:** `autorun.emergencyStop` (system) halts everything; `autorun.enabled` (project)
  is the per-project off.

## Contracts (don't break)

- **Operator is the only path to a repo write *until a class is gate-proven*** (VISION/ADR-004).
  Auto-run is the graduation of a *specific class* on a *specific project*, never a blanket
  relaxation. Default off at every scope.
- **No new merge/execution path.** Auto-run reuses submit → run → verifier gate → merge →
  Trust Ladder exactly. If the gate would hold it for review, it's held — auto-run never
  bypasses the gate.
- **Surface-first.** Every auto-run pushes and logs before/at execution. Awareness is not
  optional; the operator can always watch and kill.
- **One failure contracts.** The Trust Ladder's existing auto-contract is the safety
  interlock — a single bad outcome drops the rung and stops auto-run with no human action.

## Build sequence

1. **The eligibility gate** — a pure `isAutoRunEligible(proposal, project, config, budget)`
   returning the conjunction above (+ the reason it's ineligible). Heavily unit-tested; this
   is where the safety lives. No execution yet.
2. **Wire the Watch surface path** — where a proposal would create an inbox insight, if
   `isAutoRunEligible`, instead materialize the task + `submitRun` + `recordAutonomyEvent("auto_ran")`.
   Default config makes this a no-op (classes empty / disabled), so it ships dark.
3. **The kill-switch + budget** — `autorun.emergencyStop` system setting + per-cadence cap,
   surfaced in the Autonomy panel.
4. **Graduate the first class** — enable `groom-backlog` auto-run on one opted-in project,
   watch the event log + metrics, then widen.

## Resolutions (operator, 2026-06-28)

- **First class → `groom-backlog` only.** The reversible status-flip proving ground; no
  code-changing class auto-runs until this loop is proven on the event log + metrics.
- **Require a configured quality gate → yes.** Code-run auto-run eligibility requires the
  project to have a `quality.yaml` (so the verifier can actually reach `high`; fails closed).
  N/A to `groom-backlog`, which isn't a code run.
- **Per-cadence cap → configurable (`autorun.maxPerTick`), default 1.**

These add three config knobs (ADR-016): `autorun.maxPerTick` (default 1),
`autorun.requireQualityGate` (default true), `autorun.emergencyStop` (system kill-switch,
default false) — all in the Autonomy panel.

Note on `groom-backlog`: its "run" is auto-*executing the promotion* (close the stale task
via the existing `updateTaskStatus` seam), not a code run — so gates 4/5 (acceptance,
blast-radius) and the quality requirement apply only to code-changing classes; groom passes
on the universal gates (enabled + top-rung + class allow-list + budget + kill-switch).
