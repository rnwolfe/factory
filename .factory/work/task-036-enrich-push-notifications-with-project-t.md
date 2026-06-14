---
id: task-036
title: Enrich push notifications with project, task, and run context
status: ready
priority: med
estimate: small
created: 2026-06-14T11:00:21.390Z
updated: 2026-06-14T11:00:21.390Z
labels:
  - feedback
---

## Source

Captured from feedback kqbusbg00y9xh9ujqhfw6djx (inbox on /).

## Operator's note

Notifications lack any useful context. Just basic run completed or blocked. Don’t know which task the run was for, which project, or anything. Can we make this more robust?

## Agent's draft

Notifications in `apps/daemon/src/push/dispatcher.ts` are context-thin — "run blocked" carries only the decision outcome, no project/task/run. Standardize a richer body across both kinds (project · task · status), threading task title + run id through the decision payload (or looking them up in `payloadFor()`), keeping the existing deep-link URL. Choose a body format that reads well on a phone lock screen.

## Acceptance

- [ ] (TBD)
