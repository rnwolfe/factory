---
id: task-045
title: Re-open done task when a refinement revises its acceptance
status: ready
priority: med
estimate: small
created: 2026-06-18T03:06:51.847Z
updated: 2026-06-18T03:06:55.107Z
labels:
  - feedback
model: gpt-5.5
---

## Source

Captured from feedback q4aj05b531plukwvablqbcas (plan-detail on /plans/idd6hss4tglxsol1aiwef2hq).

## Operator's note

When adding a refinement to a completed plan that corrects the plan, it doesn’t re-open the task so that the new plan can be run. 

## Agent's draft

In `applyRefinementFreeze` (`apps/daemon/src/plans/refine.ts`), when `revisedAcceptance` rewrites a target task whose status is terminal (`done`, possibly `review`), reset it to `ready` via `tasks.updateStatus` before the commit so auto-advance re-runs the corrected plan.

Guard so only acceptance-revising refinements re-open the task (followups-only stays as-is), and note the re-open in the refinement's commit/summary so the operator sees why the task came back.

## Triage context

### Agent - 2026-06-18T03:04:19.690Z

This is a real gap and the code confirms it. `applyRefinementFreeze` (`apps/daemon/src/plans/refine.ts:59-63`) rewrites the target task's `## Acceptance` section via `updateTaskBody`, but it never touches the task's **status**. So if the task was already `done`, the refinement edits its acceptance criteria in place and then leaves it sitting at `done` — auto-advance's "next ready task" scan (`tasks.ts:98-101`) skips it, and the corrected plan never runs. Exactly what you saw.

The fix is small and localized: after a refinement rewrites acceptance for a task whose status is terminal (`done`, and arguably `review`), flip it back to `ready` before the commit, so the next run picks it up. There's already a single-point-of-truth seam for this — `updateStatus` in `tasks.ts:345` — so it's one call guarded on the task's current status, plus deciding whether to surface a note in the run summary that the task was re-opened. Worth confirming the intended trigger: only re-open when acceptance was actually *revised* (not on followups-only refinements, which already spawn their own tasks).

I'd route this as a single discrete task, not a plan — it's a known one-file change against a confirmed seam, not work that needs decomposition.

```json
{
  "kind": "task",
  "title": "Re-open done task when a refinement revises its acceptance",
  "summary": "In `applyRefinementFreeze` (`apps/daemon/src/plans/refine.ts`), when `revisedAcceptance` rewrites a target task whose status is terminal (`done`, possibly `review`), reset it to `ready` via `tasks.updateStatus` before the commit so auto-advance re-runs the corrected plan.\n\nGuard so only acceptance-revising refinements re-open the task (followups-only stays as-is), and note the re-open in the refinement's commit/summary so the operator sees why the task came back.",
  "reasoning": "The feedback names one concrete missing behavior — refinement rewrites acceptance but never flips a completed task back to runnable — and the code shows it's a single guarded `updateStatus` call against an existing seam, so it's a discrete task rather than a multi-step plan."
}
```This is a real gap and the code confirms it. `applyRefinementFreeze` (`apps/daemon/src/plans/refine.ts:59-63`) rewrites the target task's `## Acceptance` section via `updateTaskBody`, but it never touches the task's **status**. So if the task was already `done`, the refinement edits its acceptance criteria in place and then leaves it sitting at `done` — auto-advance's "next ready task" scan (`tasks.ts:98-101`) skips it, and the corrected plan never runs. Exactly what you saw.

The fix is small and localized: after a refinement rewrites acceptance for a task whose status is terminal (`done`, and arguably `review`), flip it back to `ready` before the commit, so the next run picks it up. There's already a single-point-of-truth seam for this — `updateStatus` in `tasks.ts:345` — so it's one call guarded on the task's current status, plus deciding whether to surface a note in the run summary that the task was re-opened. Worth confirming the intended trigger: only re-open when acceptance was actually *revised* (not on followups-only refinements, which already spawn their own tasks).

I'd route this as a single discrete task, not a plan — it's a known one-file change against a confirmed seam, not work that needs decomposition.

```json
{
  "kind": "task",
  "title": "Re-open done task when a refinement revises its acceptance",
  "summary": "In `applyRefinementFreeze` (`apps/daemon/src/plans/refine.ts`), when `revisedAcceptance` rewrites a target task whose status is terminal (`done`, possibly `review`), reset it to `ready` via `tasks.updateStatus` before the commit so auto-advance re-runs the corrected plan.\n\nGuard so only acceptance-revising refinements re-open the task (followups-only stays as-is), and note the re-open in the refinement's commit/summary so the operator sees why the task came back.",
  "reasoning": "The feedback names one concrete missing behavior — refinement rewrites acceptance but never flips a completed task back to runnable — and the code shows it's a single guarded `updateStatus` call against an existing seam, so it's a discrete task rather than a multi-step plan."
}
```

## Acceptance

- [ ] (TBD)

