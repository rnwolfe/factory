# ADR-022 · Cold-start auto-advance for idle autonomous projects

**Status:** accepted (2026-07-02) — shipped: `collectIdleColdStarts` +
`startIdleAutoAdvancer` (`apps/daemon/src/workers/idle-advance.ts`), wired as a
daemon tick alongside `usage-cap` / `inbox-resurface`.
**Scope:** close the gap where an idle autonomous project sits on a queue of
ready tasks with nothing running.
**Builds on:** ADR-016 (autonomy policy), ADR-012 (Trust Ladder), ADR-017
(Phase-C auto-run), ADR-019/021 (task dependencies + queue order). Complements
post-merge auto-advance; does not replace it.

## Context

Auto-advance — chaining through a project's ready queue — fires in exactly one
place: `post-merge.ts`, after a run completes **and merges**. `pickNextReadyTask`
has no other caller. That means the chain only continues while it's already
moving; nothing **starts** it. So an autonomous project ends up idle-with-ready-
work whenever the chain is interrupted:

- a daemon restart (every `factory upgrade`) kills in-flight runs and does not
  resume auto-advance on boot;
- a merge failure holds advance, and dismissing the resulting decision doesn't
  resume it;
- a project that reached the top trust rung but never had a first run kicked off.

Observed live: `signpost` (autonomous, `auto_advance` on) auto-advanced through
task-011, then stopped with task-012/013 `ready` and startable — because the
chain was interrupted and nothing cold-starts it. "Fully autonomous + tasks
ready + nothing running" is a real hole in the hands-off story. (Note: the
`autorun.classes` allow-list is unrelated — it gates auto-running Watch
*proposals*, not the operator's ready tasks.)

## Decision

Add a daemon tick (`startIdleAutoAdvancer`, 60s, alongside the other
side-effecting ticks — the Watch scheduler is advisory-only and hourly+, so it's
the wrong home) that **cold-starts the next ready task for each eligible idle
project**. From there the existing post-merge chain carries it forward.

Eligibility (`collectIdleColdStarts`, a pure read for testability) — a project
must be **all** of:

- `autonomyMode === "autonomous"` — the earned top rung. Collaborative projects
  still chain post-merge but are **not** cold-started; the operator kicks their
  first run. This is the deliberate safety boundary.
- `auto_advance` on — the existing explicit chaining toggle.
- `tag === "active"` — never cold-start archived projects.
- **no run in flight** (queued/running) — preserves auto-advance's
  one-run-per-project invariant and makes double-submission across ticks
  impossible.
- has a **startable** ready task — `pickNextReadyTask(tasks, null)` picks the
  first startable task in queue order (priority, rank, id — ADR-021), respecting
  dependency gates (ADR-019).
- **not emergency-stopped** — honors the portfolio and per-project
  `autorun.emergencyStop` kill-switch.

It is **not** gated on `autorun.enabled` (that governs Phase-C auto-run of Watch
proposals, a different mechanism). Cold-start is the completion of the
`autonomous + auto_advance` intent, not a new proposal class.

## Consequences

- **Hands-off actually means hands-off.** An autonomous project drains its ready
  queue without an operator kick, and resumes automatically after a restart or a
  transient interruption.
- **Bounded + safe.** ≤1 submit per project per tick; global concurrency is the
  worker pool's job (submits queue). Restart-safe — all state is the runs table,
  re-scanned each tick. The kill-switch and the autonomous-only gate keep it from
  running away.
- **One tick, one boundary.** The gap was structural (only post-merge advanced);
  this is the single missing trigger, not a redesign of auto-advance.

## Alternatives considered

- **Resume-on-boot only.** Fixes restarts but not the general idle case (merge
  hold, never-started). A periodic tick subsumes it.
- **Fold into the Watch scheduler.** The scheduler is advisory by construction
  (jobs emit inbox items, never side effects) and hourly-granularity; submitting
  runs there would violate that contract and be too slow.
- **A new `run-ready-task` auto-run class.** Overloads the Phase-C proposal
  mechanism (which is about Watch-generated work) with operator-authored task
  execution; keeping the two separate is clearer.
- **Gate on `autorun.enabled`.** Would wrongly exclude autonomous+auto_advance
  projects that don't opt into Phase-C proposal auto-running but do want their
  own queue drained.
