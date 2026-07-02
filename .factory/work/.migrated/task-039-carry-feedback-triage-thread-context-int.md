---
id: task-039
title: Carry feedback triage thread context into promoted task/plan
status: done
priority: med
estimate: small
created: 2026-06-14T11:09:13.535Z
updated: 2026-06-14T23:17:06.427Z
labels:
  - feedback
---

## Source

Captured from feedback klohw26djit8yi0r6n9pj6vs (feedback-detail on /feedback/z5jh6l16b68eutcjfzog5qcw).

## Operator's note

Does the context from a triage session in the inbox for feedback make it into the actual promoted task or plan?

## Agent's draft

Feedback promotion (`apps/daemon/src/feedback/promote.ts`) drops the inbox conversation: `promoteToTask`/`promoteToPlan` use only `latestDraft()` (final agent title+summary) plus the original body, never reading `feedbackComments.body`. Render the full operator/agent thread into the promoted task body (e.g. a `## Triage context` section) and into the plan summary, mirroring how `triage/orchestrate.ts` already threads `decisionComments` into its prompt. Keep the distilled draft as the headline; append thread as supporting context.

## Acceptance

- [ ] (TBD)

