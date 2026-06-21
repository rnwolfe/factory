---
id: task-058
title: Cross-project open-task aggregation in the daemon
status: ready
priority: med
estimate: medium
created: 2026-06-21T12:18:24.342Z
updated: 2026-06-21T12:18:24.342Z
labels:
  - feature-plan-task
sourcePlanId: w81q7q32la3tcj5q1sevear9
---

## Acceptance

- [ ] A daemon-side query returns, for each project, its standard open tasks sourced from `projects/tasks.ts`.
- [ ] A project is included whenever it has at least one open task — no staleness, activity, or N-day condition gates inclusion.
- [ ] Each returned task carries enough identity (task id + project id/slug + title) to link back to its source.
- [ ] Projects with zero open tasks are omitted from the result.

## Notes

Emitted by feature plan w81q7q32: "Cross-project incomplete/stalled task view"

