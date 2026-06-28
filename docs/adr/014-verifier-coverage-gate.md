# ADR-014 · The Verifier-Coverage Gate

**Status:** accepted (2026-06-28)
**Scope:** the autonomy initiative — WS C from
`docs/research/2026-06-27-autonomous-proactive-factory.md` §C.
**Builds on:** v0.1 auto-merge-on-green, the factory-status acceptance contract
(`runner.ts` acceptance downgrade), quality checks (`quality.ts`, ADR informational→gating
arc). Prerequisite for ADR-011 Phase C (Watch-generated work auto-runs) and the Trust
Ladder's upper rungs (L3/L4).

## Context

Auto-merge gates on `finalStatus === "completed"`. But **"completed" ≠ "verified."**
The completion contract is honest about the *agent's self-report* (and already downgrades
to `blocked` when any acceptance criterion reports `met: false`), yet it says nothing about
*how much independent checking actually happened*. A run that "completed" with **zero
acceptance criteria and no quality checks** had nothing verify it — it is the most dangerous
thing to auto-land, and today it looks identical to a fully-verified run.

The autonomy thesis (MM1, "autonomy = verifier coverage"): the inbox is the residual of
*unverifiable* work. To shrink it safely we must **measure** verifier coverage, not assume it.

## Decision

Compute a **verifier-confidence report** per code-changing run, from signals that already
exist, and treat *coverage breadth* — not just pass/fail — as the thing being measured.

### The signals (each a coverage state, not just a boolean)

| Signal | `pass` | `fail` | **`absent`** (the dangerous case) |
|---|---|---|---|
| **acceptance** | had testable criteria, all met | a criterion unmet | **no checkable criteria** |
| **quality** | checks configured + green | checks failed | **no checks configured** |
| **cross-model** (ADR-D, later) | other family validated | validator dissents | not run |

`absent` contributes **zero** coverage — that is the whole point. A completed run with all
signals `absent` scores 0: *nothing verified it*, so it is **not autonomy-eligible** even
though it "completed."

### The score

A weighted sum over the signals (acceptance 0.6, quality 0.4 today; cross-model joins when
ADR-D lands and re-weights), producing a `score ∈ [0,1]` and a `level`:

- `high` ≥ 0.8 · `medium` ≥ 0.5 · `low` > 0 · `none` = 0

The report also carries the per-signal breakdown, so it doubles as the **execution-evidence
narrative** (research §G) on a merge.

### Informational first, gating second (deliberate sequencing)

Slice 1 (this ADR's initial implementation): **compute + persist + surface** the report.
It changes **no routing** — auto-merge still gates on `completed`. This mirrors how quality
shipped (informational in v0.2, gating in v0.3): we watch the score against real runs before
trusting it to hold back a merge.

Slice 2 (follow-up): the gate. `level` + a **reversibility/blast-radius** classification of
the diff routes the outcome — **high + contained → auto-land; otherwise → `review` in the
inbox**. Slice 3: **frozen, testable acceptance criteria become a freeze precondition** for
autonomy-eligible plans (*no checkable criteria = not eligible*), closing the `absent` case
at its source.

## Contracts (don't break)

- **The score is informational until the gate slice ships.** Do not let slice 1 hold back a
  merge — that would silently change v0.1 behavior.
- **`absent` ≠ `pass`.** Never collapse "nothing checked it" into "it's fine." The coverage
  states are three, not two; this is the operational core of MM1.
- **Compose existing signals; don't reimplement them.** Read acceptance from the parsed
  factory-status block and quality from the `QualityReport`. Cross-model plugs in as one more
  signal, never a parallel system.
- **Auto-landing self-generated work stays gated behind this + the Trust Ladder** (ADR-011 §
  Phase C). The verifier gate is the *throttle*; it does not itself widen autonomy.

## Seams

`apps/daemon/src/workers/verifier.ts` (new — the computation), `runner.ts` (compute after
quality, persist on the run), `quality.ts` (`QualityReport`), `factory-status.ts` (acceptance),
`runs.verifier_report` (new column). Future gate: `runner.ts` merge path; future precondition:
the plan-freeze guard.
