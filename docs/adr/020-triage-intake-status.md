# ADR-020 · `needs_triage` — adopted external work is inert until vetted

**Status:** accepted (2026-07-01) — shipped: the `needs_triage` task status, the
`adopt()` change (issue-intake + bulk reap land here, not `ready`), the
`isStartable` gate (already excludes non-`ready`, so auto-advance skips it for
free), the router `TaskStatusEnum`, and the PWA (distinct chip + a "mark ready"
promote control that gates `start`).
**Scope:** a new *open, non-startable* task status for work Factory adopted from
an external source but has not vetted, ordered, or cleared to run.
**Builds on:** ADR-007 (GitHub Issue backend + D4 "external issues never become
silent tasks"), ADR-019 (task dependencies + `isStartable`), the reap/import
feature (bulk adoption of pre-existing upstream issues).

## Context

Adopting an external GitHub issue (single `issue_intake` approve, or a bulk
reap) PATCHed it to `status:ready`. Combined with auto-advance — on by default —
that made every adopted issue immediately **startable**: `pickNextReadyTask`
picks the lowest-numbered `ready` task with satisfied deps, and adopted issues
carry **no `blockedBy` edges** and **no vetting**.

This surfaced on the live **dwell** project: a 14-issue seeded backlog was
adopted uniformly as `status:ready`, while the issues' real state lived in
upstream labels and body prose that Factory ignored —

- `#273` labelled `icebox`, body: *"Watch / icebox — do not build until the
  trigger fires"*;
- `#279 / #277 / #272` labelled `backlog/needs-refinement` (*"needs refinement
  before implementation"*);
- `#266` an **Epic** (a container, not an implementable task);
- ordering/prerequisites ("AR needs a 3D-capture path that isn't built";
  "Phase 3 — relates SHR-1, REN-3") encoded only in prose.

With auto-advance on, the first run would have started `#266` (the Epic) and
marched up by issue number — running the icebox item and unrefined work in an
order that ignored the epic/phase/prerequisite structure entirely. (No run had
fired yet; the risk was latent.)

The root gap: **nothing distinguished "adopted into tracking" from "vetted,
ordered, and cleared to auto-run."** `ready` conflated the two.

## Decision

Add a first-class task status **`needs_triage`**: the intake holding state for
adopted external work.

- It is an **open** status (`statusToGithub` → `open`; it rides a
  `status:needs_triage` label and a `needs_triage` value in the issue's
  `factory:task` meta block), so it stays on the active board — visible, not
  hidden.
- It is deliberately **not startable**: `isStartable` gates on `status==="ready"`
  (ADR-019), so a `needs_triage` task can never be picked by
  `pickNextReadyTask` / auto-advance. The safety property is structural, not a
  special-case check.
- **`adopt()` lands `needs_triage`, not `ready`** — for both single-issue intake
  and bulk reap. It only sets a status when the issue has none
  (`?? "needs_triage"`), so re-adopting never downgrades a task already moved
  along its lifecycle.
- The operator **promotes** it to `ready` (the PWA task view shows a "mark ready
  to run" control instead of "run task") once they've vetted it and set any
  `blockedBy` edges (ADR-019). Only then does it enter the runnable pool.

This makes the ordering hazard **impossible by default**: adopted work is inert
until a human clears it, rather than runnable-unless-caught.

## Consequences

- **Honors D4 more literally.** ADR-007 said external issues never become
  *silent* tasks; now they never become *runnable* tasks either, until vetted.
- **Dwell remediation:** the 14 already-`ready` issues are moved to
  `needs_triage` (a status write per issue via the backend); nothing runs until
  each is promoted. Auto-advance can stay on — every relic is non-startable.
- **Not startable ≠ hidden.** `needs_triage` is not in `CLOSED_TASK_STATUSES`,
  so it shows on the active board and counts as an open task, just not a *ready*
  one (`readyTaskCount` excludes it).
- **Follow-ups (not built here):** a canonical Factory label set applied on
  onboarding (deferred pending the factory-vs-Heimdall naming decision); a
  batch/triage flow to promote+order many `needs_triage` tasks at once; optional
  auto-refinement that reads upstream labels/prose to propose deps.

## Alternatives considered

- **Adopt as `blocked`.** Reuses an existing status with no enum change, and
  `isStartable` already excludes it — but `blocked` means "blocked by a
  dependency/blocker," conflating dep-blocked with awaiting-triage. A distinct
  status is self-documenting on the board.
- **Keep `ready`, map upstream labels** (`icebox`/`needs-refinement` → hold).
  Fits dwell today but hard-codes a per-repo label taxonomy Factory doesn't own;
  fragile across projects.
- **Make auto-advance skip adopted-without-review tasks.** Muddies the
  `isStartable` predicate with provenance; the status-based gate is cleaner and
  visible to the operator.
