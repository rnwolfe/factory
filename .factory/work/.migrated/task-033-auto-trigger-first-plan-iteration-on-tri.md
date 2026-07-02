---
id: task-033
title: Auto-trigger first plan iteration on triage-approve (and startRefinement)
status: done
priority: med
estimate: small
created: 2026-06-14T10:54:33.432Z
updated: 2026-06-14T13:05:51.070Z
labels:
  - feedback
---

## Source

Captured from feedback t17ij4dze5blhq4hugye9t74 (plan-detail on /plans/hhw18821mggmmj42o4mxgmdc).

## Operator's note

Plans never draft upon landing promoted in inbox (they get stuck on “drafting”) but work fine after I nudge with a comment to draft the plan. 

## Agent's draft

Plans created via triage-approve land in `drafting` but never auto-draft because `decisions.ts:315-382` omits the `runPlanIteration()` kick that every `start*` endpoint runs.

Add the same fire-and-forget block used by `startTaskPlan`/`startFeaturePlan` (publish `plan_created`, then background `runPlanIteration`, emitting `plan_comment_added`/`plan_updated`/error events) to the triage-approve branch. Apply the same fix to `startRefinement` (`plans.ts:422-467`), which has the identical gap.

## Acceptance

- [ ] (TBD)


