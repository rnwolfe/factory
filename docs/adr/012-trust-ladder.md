# ADR-012 · The Trust Ladder — graduated, auto-contracting run autonomy

**Status:** proposed (2026-06-27)
**Scope:** the autonomy initiative — WS A from
`docs/research/2026-06-27-autonomous-proactive-factory.md`.
**Relates to:** the throttle ADR-011 (Watch work-generator) depends on for its
auto-run half. Replaces the binary `autonomyMode` (`schema.ts:27`).

## Context

Factory has one autonomy knob today: `projects.autonomyMode ∈
{collaborative, autonomous}`, consumed at `runner.ts:351`
(`decisionsEnabled = autonomyMode === "collaborative"`). It governs one thing —
how mid-run **architectural forks** are handled:

- **collaborative:** the agent emits `factory-decision` blocks; the daemon
  persists them as **pending** `agent_decision` inbox cards
  (`workers/agent-decisions.ts`). These are ~42% of inbox landings.
- **autonomous:** the footer tells the agent *not to emit* forks at all — "pick
  the most defensible path and note your choice in the summary"
  (`factory-status.ts:415`). The operator's only recourse is "flip to
  collaborative and re-run, or file a refinement task."

**The crucial correction (operator, 2026-06-27): `agent_decision` is not a
blocker — it is after-the-fact ratification.** The agent already chose the
defensible path and *kept going / shipped*; the run never paused (architecture
brief: agent_decision = "No (run continues)"). The inbox card costs **attention**
(ratify or override), not throughput. And **override is a post-hoc redirect** —
`decisions/resurface.ts` re-queues the work as a new `"resurfaced"` task; it
changes direction after the fact, it never gates the original run.

That reframes everything. The lever for `agent_decision` is **mandatory
ratification attention, not unblocking.** And it exposes that today's binary is
lossy at both ends:

- collaborative = *ratify everything* (max attention, the 42%),
- autonomous = *agent emits nothing* → prose-only choices, **no structured
  override**, crude "re-run in collaborative" recourse.

The missing middle — **auto-ratify the fork but keep the structured override** —
is the sweet spot, and it doesn't exist. That is the human-*in*-the-loop →
human-*on*-the-loop move, and **the override is precisely what makes
auto-ratification safe**: you lose nothing by not ratifying upfront, because you
can still override after reviewing the result.

## Decision

Replace the binary with a **graduated, track-record-driven Trust Ladder**: a
per-project (later per-task-class) level that decides how much of the
already-non-blocking machinery requires the operator's attention, and which
genuinely-blocking events may auto-resolve. Higher levels are **earned** and
**auto-contract** on a broken track record.

### The levels

| Level | `agent_decision` forks | `blocked_run` / `merge_failure` | self-directed work |
|---|---|---|---|
| **L1 Collaborator** *(today's collaborative)* | emitted → **pending** card; operator ratifies/overrides | human resolves | none |
| **L2 On-the-loop** *(the new sweet spot)* | emitted → **auto-ratified** (recorded `actioned`, flagged), **override stays available** post-hoc | human resolves | none |
| **L3 Approver** | auto-ratified | **transient** failures auto-retry within a bounded budget, escalate on exhaustion | none |
| **L4 Observer** | auto-ratified | auto-retry | Watch-generated work auto-runs (ADR-011 Phase C), surface-first for irreversible/high-blast |

The agent's behavior is **unchanged across levels** — it always emits
`factory-decision` forks (the lossy autonomous "don't emit" footer is retired).
The ladder is a **daemon-side policy** on what those forks (and blocks) demand of
the operator. This is what makes L1→L2 the cleanest, lowest-risk first lever:

> **L1 → L2 is one change:** create the `agent_decision` row with status
> `actioned` + `autoRatified: true` instead of `pending`. The run already
> continued; the card just no longer demands attention. Override is unchanged —
> the operator can still override an auto-ratified decision (→ resurface). Zero
> throughput risk, because these never blocked.

Auto-ratified decisions are **not discarded** — they're a reviewable digest
("what the agent decided autonomously since you last looked"), each carrying the
existing override affordance. Opt-in review replaces mandatory ratification.

### Auto-movement (the "ladder", not a "switch")

The level is a **trust score that moves itself** (MM2 — Karpathy's auto-contracting
slider):

- **Ratchets up** after N consecutive clean outcomes for the project: runs that
  completed, merged verifier-green (WS C), and whose auto-ratified forks the
  operator did **not** override.
- **Contracts immediately** (drop a level) on any of: a run failure, a merge
  conflict, or an **operator override of an auto-ratified fork** — an override is
  the precise signal that trust was misplaced. No committee, automatic.

Read the track record from the `runs` + `decisions` tables; surface the current
level + trend in the project header beside the TierPicker.

## Contracts (don't break)

- **Operator is the only path to a repo write** (VISION / ADR-004 §9). The ladder
  changes *attention*, not the merge boundary, until L3/L4 — and even L3 only
  auto-retries already-failed work within a bounded, operator-visible budget that
  hands back on exhaustion (the report's most-cited field gap).
- **Auto-ratification must preserve override.** An auto-ratified `agent_decision`
  is `actioned` + flagged, always overridable post-hoc. Never silently dropped —
  that's the safety valve, not optional.
- **A clean `blocked` is still success.** L3 auto-retry is for *transient* causes
  (flaky check, transient infra), never for the structural blocks (missing
  secret, hardware, subjective verdict) that are irreducibly human — those always
  surface (research: blocked_run is 29% of inbox, all external-dependency).
- **Earned, not declared.** Levels above L1 are reached by track record or
  explicit operator opt-in, and contract automatically. New `personal+` projects
  do not start autonomous.

## Build sequence

- **Slice 1 (this ADR's core):** the level model (replace/extend `autonomyMode`)
  + **L2 auto-ratification** of `agent_decision` (`actioned` + `autoRatified`
  flag) with override preserved + PWA: an auto-ratified digest/affordance and the
  level shown in the project header. **Operator sets the level manually.** Retire
  the lossy autonomous "don't emit" footer; all levels emit forks.
- **Slice 2 — auto-movement.** The track-record ratchet + auto-contract on
  override/failure. This is what turns the switch into a ladder.
- **Slice 3 — L3 bounded auto-retry** for transient `blocked_run` / `merge_failure`
  with an operator-visible retry budget that escalates on exhaustion.
- **L4** is ADR-011 Phase C (Watch-generated work auto-runs), gated by WS C.

## Migration

`autonomyMode` → a `trustLevel` (L1–L4) or keep the column and add a level. Map
existing `collaborative → L1`, `autonomous → L2` (note: today's `autonomous`
suppressed emission; L2 instead auto-ratifies *emitted* forks — strictly more
visible/controllable, so the migration is an upgrade in safety, not a relaxation).
Bootstrap default by tier stays conservative (`tinker → L2`, `personal+ → L1`).

## Open questions

1. **Per-task-class levels?** Or per-project only to start? (Start per-project.)
2. **Ratchet thresholds.** What N (consecutive clean) earns a step up, and is the
   contract always exactly one level? (Propose N=5, contract one level; tune on data.)
3. **Digest surface.** Where do auto-ratified forks live for opt-in review — a
   filter in history, a per-run "auto-decided" section, or a periodic digest card?
   (Lean: per-run section + a history filter; no new attention sink.)
4. **Does L2 ever pause?** No — forks never blocked; L2 only changes the card's
   status. The only thing that still blocks at any level is a genuine
   `blocked_run` (until L3 auto-retries the transient subset).
