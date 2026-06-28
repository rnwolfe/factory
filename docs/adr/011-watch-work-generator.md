# ADR-011 · The Watch as a proactive work generator

**Status:** proposed (2026-06-27)
**Scope:** the autonomy initiative — extends ADR-010 (The Watch).
**Builds on:** ADR-010 (Watch substrate: sources, scheduler, synthesis →
observations → `watch_insight` inbox; slices 1–3c shipped). Depends, for its
autonomy payoff, on the WS A "Trust Ladder" and WS C "Verifier-Coverage gate"
from `docs/research/2026-06-27-autonomous-proactive-factory.md`.

## Context

ADR-010 gave The Watch eyes: it scans the operator's out-of-band sessions
(Claude Code / Codex), synthesizes patterns, and surfaces them as notify-grade
`watch_insight` cards. That substrate works — but living with it surfaces an
honest limit, raised by the operator: **surfacing reflective insight is the
learning substrate, not the autonomy lever.**

The autonomy thesis is unchanged: autonomy = verifier coverage; the bottleneck
is *judgment* (~0.6 decisions/run, flat as volume tripled); the win is a
*smaller* inbox and *proactive* attention. Measured against that, a card that
says "you keep scaffolding CLIs by hand" informs the operator — it does not
reduce decisions-per-run. It is a smarter mirror, not less work.

The lever ADR-010 named but did not build (§1, "ambient self-generated intake")
is The Watch as a **work generator**: not "here is an interesting pattern" but
"here is a *task / plan / audit / project / bug* I have queued, of the right
type, ready to flow through the machinery that already exists." Three gaps
separate today's Watch from that:

1. **Output is reflective, not typed work.** The observation kinds
   (`repeated-ritual`, `new-convention`, …) describe *what was seen*. They don't
   map cleanly onto Factory's execution primitives (task, plan, audit, project),
   so an insight mostly ends as a note, not as queued work.
2. **It only watches out-of-band.** Sources are `~/.claude` / `~/.codex`. To
   generate the *right* next work — and to **groom** rather than only add — it
   must also see Factory's own state: failing/stale runs, open audit findings,
   each project's task backlog and repo, the decisions history.
3. **Generation alone is still inbox.** More cards, better-aimed, is the same
   human bottleneck. Decisions-per-run only drops when a *safe subset* of
   generated work can execute without the operator.

## Decision

Reframe The Watch from an *observer that surfaces insight* to a **proactive work
generator that feeds Factory's existing primitives, fed by both out-of-band and
in-band signal, with a gated path to auto-execution.** Three moves.

### 1. Typed work proposals mapped to existing primitives

The synthesizer's output gains a primitive-typed target. The Watch never
reimplements a primitive — it **feeds** the one that already exists, through its
single-source-of-truth seam:

| The Watch observes… | emits a… | promotes into (existing seam) |
|---|---|---|
| recurring bug signature / error pattern | **bug** | `createTask` (`projects/tasks.ts`) |
| a feature repeatedly gestured at | **feature_plan** seed | a drafting plan in the inbox (like triage approve) |
| architectural smell / drift | **audit** | `audits.submit` / promote an existing finding |
| a whole new thing being circled | **project** | triage → `project_spec` draft |
| stale / obsolete / duplicate backlog item | **groom action** | task close / re-prioritize via the task seam |
| durable preference / convention | **convention** | `AGENTS.md` / operator-memory (ADR-010 §4) |
| genuinely just FYI | **note** | stays a `watch_observation` (the residual) |

`note-only` becomes the *residual*, not the default — most output should be
candidate work. Promotion always routes through the primitive's existing
single-point-of-truth (no duplicate task/plan/audit logic in `watch/`).

### 2. In-band sources alongside harness sources

Generalize the source registry beyond harnesses. A **signal source** emits
normalized records of *something Factory could act on*; `HarnessSource` (the
operator's out-of-band work) is one family, **in-band sources** are the other:
the runs/decisions tables, open audits & findings, per-project task backlogs and
repo/git state. Same registry discipline (one entry per source, no consumer
branches on id). With in-band signal The Watch can **groom and prioritize** —
"backbar has a ready task that's now obsolete," "nxstate hasn't been audited in
3 weeks," "rivr's last 3 runs failed the same way" — not only reflect.

### 3. The generation → gating loop (the actual autonomy)

Generated work surfaces to the inbox **by default** (safe; the operator is the
only path to a repo write). A *class* of generated work graduates to **auto-run**
only once it earns it, through the report's WS A/C:

```
The Watch generates typed work
        │
        ▼
  Verifier-Coverage gate (WS C) + Trust Ladder level (WS A)
        ├─ high confidence · low blast-radius · verifiable ──▶ auto-run (plan→run→auto-merge)
        └─ ambiguous · judgment-heavy · irreversible ───────▶ inbox (operator decides)
```

This is the whole thesis closing: **self-generated work, throttled by earned
trust and automatic verification.** The Watch is the *generator*; A/C are the
*throttle*. Neither alone is autonomy.

## Contracts (don't break)

- **Operator is the only path to a repo write** (VISION / ADR-004 §9). Until a
  class is gate-proven, every promotion is operator-initiated. Auto-run is
  *surface-first, graduate-on-track-record* — never default-on.
- **Feed primitives, never reimplement them.** Promotion goes through
  `createTask` / the plan-draft seam / `audits.submit` / triage — the same
  single-source-of-truth modules every other path uses.
- **Precision over recall.** A chatty generator is worse than none. Dedup hard
  (against both prior observations *and* the existing backlog — never propose a
  task that already exists), default to `note` when unsure, and let the operator
  throttle per project.
- **Auto-executing self-generated work is the most dangerous surface in the
  system.** It is gated behind WS A + WS C and starts off. This ADR builds the
  generator; the gate is its prerequisite for the auto-run half.

## Re-sequencing

ADR-010 slices 1–3c (substrate) are merged. This ADR re-prioritizes the rest,
putting the autonomy-moving work ahead of the learning-half polish:

- **Phase A — typed proposals + promotion paths.** Extend the proposal taxonomy
  and wire promotion into feature_plan, audit, and triage (task is already wired
  via 3c adopt-as-task). Backlog-groom action.
- **Phase B — in-band sources + cadence/groom jobs.** The signal-source
  generalization + ADR-010 §1 cadence jobs (backlog grooming,
  decompose-next-milestone, scheduled audits) now have real producers.
- **Phase C — generation → gating.** Depends on WS A (Trust Ladder) + WS C
  (Verifier-Coverage gate). The safe subset auto-runs; the rest surfaces.
- **ADR-010 §4 operator-memory repo + PWA viewer** — the learning/grounding
  half. Still wanted (it grounds every future run), but a **fast-follow**, not a
  blocker for the generator. `record-as-convention` becomes fully functional
  when it lands.

## Open questions

1. **Generation aggressiveness.** Volume control / per-project opt-in so The
   Watch doesn't flood the single attention sink. A per-project "let The Watch
   propose work" flag, off by default for `tinker`?
2. **feature_plan promotion shape.** Does The Watch *draft* the plan, or only
   seed a drafting `project_spec`/`feature_plan` in the inbox the way triage
   approve does (operator iterates to freeze)? Leaning seed-only — keep the
   freeze gate and the vision filter intact.
3. **Backlog-aware dedup.** Promotion must check the target project's existing
   tasks/plans/findings so it grooms rather than duplicates. Where does that
   check live — in each promotion seam, or a shared "is this already tracked?"
   pass before surfacing?
4. **In-band source cost.** Scanning every project's repo/backlog each cadence
   has IO cost; reuse the cursor pattern and a per-project lookback.
