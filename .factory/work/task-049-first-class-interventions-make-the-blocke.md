---
id: task-049
title: First-class interventions — make the blocker→reply→re-run loop queryable
status: done
priority: med
estimate: medium
created: 2026-06-20T05:10:00.000Z
updated: 2026-06-20T05:10:00.000Z
labels:
  - audit
  - observability
---

## Source

Prod-usage audit (14d ending 2026-06-20), feature proposal #2. See
`tasks/audit-prod-14d-2026-06-20.md`.

## Operator's note

The richest run-quality signal — what got stuck, what the operator did, and the
outcome — is currently invisible to any audit. The `_intervention-logs/*.log`
files are hollow (incidental tmux scrollback, e.g. an operator running
`git status`), and the real intervention loop lives untracked in the
`runs.blocker_questions` / `runs.operator_context` columns.

## Context (what already exists)

The `interventions` table already exists and is used for the narrow
"operator jumps into a stuck worktree to repair, then resumes the same agent
session" case (commit `32fd7df`; 2 rows in prod, merge_failure cancelled/resumed).
What is NOT first-class: the much more common `blocked run → operator replies via
operator_context → retry run` dialog. In the 14d window there were 16 actioned
`blocked_run` decisions and 6 blocked runs whose resolution exists only as free
text scattered across `decisions`, `runs.blocker_questions`, and
`runs.operator_context`. There is no single queryable record of the chain.

## Agent's draft

Extend the existing `interventions` primitive (don't invent a parallel one) to
record the blocker→reply→re-run loop as a first-class row:

- When a run goes `blocked` and the operator replies (the
  `decisions.replyToBlockedRun` / `operator_context` path,
  `apps/daemon/src/routers/decisions.ts` + `workers/submit.ts`), open/append an
  `interventions` row linking: `source_run_id`, `decision_id`, the blocker
  question(s), the operator reply, and the resulting retry run id
  (`runs.retry_of_run_id`).
- Close the intervention with an outcome when the retry resolves
  (completed / still-blocked / failed).
- Surface the chain in the run/decision detail in the PWA so the operator (and a
  future audit) can read "stuck on X → operator answered Y → re-ran → outcome Z"
  in one place.
- Retire or repurpose `worktrees/_intervention-logs/` — either capture a real
  structured transcript there, or drop the directory so it stops reading as an
  audit surface that's actually empty.

Confirm the seam with the existing worktree-repair intervention flow so both
intervention kinds share the table and the detail view.

## Acceptance

- A blocked-run → operator-reply → retry sequence produces one queryable
  `interventions` record linking source run, decision, blocker question,
  operator reply, retry run, and final outcome.
- The intervention chain is visible in the PWA run/decision detail.
- The existing worktree-repair intervention flow still works (shared table).
- `_intervention-logs/` either carries a real structured record or is removed;
  no hollow `.log` files masquerading as intervention history.
