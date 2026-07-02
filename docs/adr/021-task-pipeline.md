# ADR-021 · First-class task pipeline — lifecycle, ordering, and epic hierarchy

**Status:** accepted (2026-07-01) — design accepted; built in phases (§7). Spike:
[`docs/research/2026-07-01-task-pipeline-spike.md`](../research/2026-07-01-task-pipeline-spike.md).
**Scope:** promote the task model from an unordered ready-pool + flat status enum
to three **orthogonal** first-class axes — a lifecycle state machine, operator
queue ordering, and epic/sub-issue hierarchy — mapped losslessly onto both task
backends and surfaced in the PWA.
**Builds on:** ADR-007 (GitHub Issue backend), ADR-019 (dependency edges),
ADR-020 (`needs_triage` intake), ADR-009 (milestones), ADR-012/016/017 (autonomy /
auto-advance). Supersedes nothing; extends the `TaskStore` seam.

## Context

Post-ADR-020 the task model is still thin (see the spike §1 for the full map):

- **Statuses**: `needs_triage | ready | in_progress | review | done | blocked |
  dropped`, but **`in_progress`/`review` are vestigial** — the daemon never
  writes them; the *run* row (`running` / `needs_review`) is the canonical
  in-flight/verify signal. The real driven lifecycle is `needs_triage → ready →
  (run) → done | blocked` + `dropped`. There is no "accepted but not yet queued"
  state — the gap between `needs_triage` (unvetted) and `ready` (pickable).
- **Ordering**: `pickNextReadyTask` picks the first startable task in **numeric
  id order**. `priority` is written everywhere and **read by no pick path**.
  There is no operator queue ordering, no rank, no lanes.
- **Hierarchy**: `parent`/`milestone` are **provenance only**; nothing reads them
  for pick/order/display. No epic/sub-issue concept. The only live relation is
  `blockedBy` (ADR-019), a DAG gating `isStartable`.
- **PWA**: a flat active/archived list, not lanes.

Industry prior art (spike §2) is consistent: a two-layer model (state label →
fixed category), a Triage→Backlog→Ready split for an auto-picker, review typed
*under* in-progress (never its own bucket), **two terminals** (done vs canceled),
blocked as an **attribute** not a state, hierarchy and dependencies kept
**orthogonal**, and ordering via a **fractional-index rank** (not a float).
GitHub's 2025 GA wave made sub-issues, issue types, and dependencies
**issue-native and bot-writable**, but richer status remains Project-scoped — so
lifecycle state must ride **labels**, not a Project Status field.

## Decision

Three orthogonal axes on the task model. Resolved design questions (spike §7):
**D1** derive execution states from runs; **D2** keep `needs_triage` + add
`backlog`; **D3** one ADR, phased build; **D4** labels-as-canonical-status on
GitHub; **D5** opt-in epic auto-close.

### A. Lifecycle state

**Persisted** task status: `needs_triage → backlog → ready → done`, terminal
`dropped`, plus `blocked`.

| State | Meaning | Startable? | GitHub mapping |
|---|---|---|---|
| `needs_triage` | adopted/unvetted intake (ADR-020); display "triage" | no | open + `status:needs_triage` |
| `backlog` | **NEW** — vetted/accepted, not yet queued | no | open + `status:backlog` |
| `ready` | queued & pickable — the **only** startable state | **yes** | open + `status:ready` |
| `blocked` | a run couldn't finish; needs operator attention | no | open + `status:blocked` |
| `done` | shipped | terminal | closed / `completed` |
| `dropped` | canceled / won't-do (second terminal) | terminal | closed / `not_planned` |

**Execution states are derived, not persisted (D1).** `in_progress` and
`in_review` are computed from the active run (`running` / `needs_review`) and the
verify/decision step — the board composes persisted-status + live-run-status into
lanes. A task's persisted status stays `ready` while a run is in flight; the run
terminates it to `done`/`blocked` (today's `taskStatusFor`). This preserves the
runner's deliberate "don't write `in_progress` to the task file" invariant
(`runner.ts:265-270`) and avoids runner↔task-file write races. The vestigial
`in_progress`/`review` union members are retained for back-compat/read
tolerance but are not written by the pipeline.

`isStartable` continues to gate on `ready` (so `needs_triage`, `backlog`,
`blocked` are never auto-picked). `CLOSED_TASK_STATUSES` = `{done, dropped}`.

### B. Ordering

- Add a **`rank`** fractional-index **string** to the task model (frontmatter
  field / GitHub meta), generated with a `generateKeyBetween`-style scheme
  (arbitrary-precision, single-row reorder writes — never floats).
- Keep `priority` as a coarse bucket; **`pickNextReadyTask` sorts ready tasks by
  `(priority, rank)`** instead of numeric id. This is the operator's "order the
  queue" lever, replacing id-order (which stays only as the tiebreak/backfill).
- Reorder = rewrite **one** task's `rank`. No neighbor touches; optional one-shot
  re-spacing if strings get long (poor-man's LexoRank rebalance).

### C. Hierarchy (epic → sub-issue)

- First-class parent/child containment, **orthogonal to `blockedBy`** — hierarchy
  is for decomposition + rollup and **does not gate startability** (only the
  dependency DAG does). An epic is a real workable task with its own status.
- **Rollup**: derived `subIssuesSummary {total, completed, percentComplete}`.
  **Opt-in auto-close (D5)**: a per-project (and per-epic override) toggle;
  default OFF — when all children are terminal, auto-complete the parent. Off by
  default matches Jira; the toggle matches Linear.
- Mapping: GitHub → **native sub-issues** (100/parent, 8 deep, one parent);
  file → `parent:` frontmatter + derived children + emulated summary.

### D. Pluggable `TaskStore` deltas

New interface methods (file = frontmatter; github = native primitive):

- `setParent(id, parentId | null)` / `listChildren(id)` → GitHub native
  sub-issues API; file `parent:` + derived.
- `setRank(id, rank)` (or `reorder(id, beforeId, afterId)`) → GitHub sub-issue
  priority endpoint / `rank` meta; file `rank:` frontmatter.
- `subIssuesSummary(id)` → GitHub `subIssuesSummary`; file derived.

Lifecycle state stays **label-based** on GitHub (`status:*` + open/closed +
close-reason) — never a Project Status (issue-scoped, bot-writable, no Project
dependency, keeps state repo-canonical). **Follow-up (Phase 5):** move `blockedBy`
off the meta block onto GitHub's **native dependency API** (the ADR-019 slice).

### E. PWA UX

- Task board → **lifecycle lanes** (triage · backlog · ready · in progress ·
  review · done), **phone-first** at 390px (horizontal-scroll or vertical
  accordion). `in progress`/`review` lanes are populated from active runs (D1).
- **Drag to reorder** within `ready` (writes `rank`); **drag across lanes** to
  change state, with the ADR-020 guard (promoting *into* `ready` stays the
  deliberate vetting gate).
- **Epic grouping**: collapsible children under a parent with a rollup progress
  bar; keep the dependency editor and `blocks`/`blockedBy` chips.

## Phasing (each independently shippable)

1. **Spike + this ADR.** ✅
2. **Lifecycle:** add `backlog`; label/meta + `statusToGithub`/`reconcileStatus`
   mapping; board distinguishes triage/backlog/ready; derived in-progress/review
   lanes.
3. **Ordering:** `rank` field + `generateKeyBetween` util; `pickNextReadyTask`
   sort by `(priority, rank)`; operator reorder UI.
4. **Hierarchy:** `setParent`/`listChildren`/summary at the seam; GitHub native
   sub-issues; file emulation; epic grouping + rollup UI; opt-in auto-close.
5. **Native GitHub deps:** migrate `blockedBy` from meta block → native
   dependency API (ADR-019 follow-up).
6. **PWA lane board polish** (drag, phone-first) — may interleave with 2–4.

## Migration

- `needs_triage` semantics unchanged (ADR-020); `backlog` is additive.
- `rank`: backfill from current numeric-id order on first write (lazy) so
  existing queues keep their order until an operator reorders.
- `parent`: existing provenance `parent:` values are back-pointers; adopting them
  as hierarchy edges is opt-in per project to avoid retro-restructuring.
- New `status:backlog` label auto-created on first use (GitHub PATCH creates
  labels named in the issue edit). No DB migration needed for statuses (task
  status is not a DB-enforced enum on the task rows; the `schema.taskStatusEnum`
  used by run bookkeeping gains `backlog`).

## Consequences

- **Operator gets a real queue**: order tasks, hold work in `backlog`, promote to
  `ready` deliberately, group epics — the Dwell relic problem (ADR-020) becomes a
  first-class board flow, not a status-flip workaround.
- **`priority` stops being dead weight** (feeds ordering).
- **Both backends stay lossless** — every axis has a GitHub-native + markdown
  representation; no Project dependency for state.
- **Risk:** the lane board is the biggest surface; phone-first lanes + drag need
  care (Phase 6). Derived execution lanes must stay cheap (already computed via
  `activeRunByTask`).

## Alternatives considered

- **Persist `in_progress`/`in_review` on the task** (D1 alt): simpler "status =
  truth" but reintroduces runner↔task write races the runner avoids today.
- **Rename `needs_triage` → `inbox`** (D2 alt): matches the proposal verbatim but
  collides with the *decisions* inbox and re-labels a just-shipped state.
- **Project Status field for lifecycle** (D4 alt): richer built-in board, but
  Project-scoped (not issue-native), needs extra permission + field/option-ID
  resolution, and breaks "state is repo-canonical."
- **Float rank / renumber-on-reorder**: precision exhaustion / O(n) writes.
