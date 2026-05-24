---
id: task-014
title: "PWA: Retry in worktree affordance on failed runs"
status: ready
priority: med
estimate: small
created: 2026-05-24T01:46:25.612Z
updated: 2026-05-24T01:46:25.612Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] a 'Retry in worktree' button is rendered on the run detail view only when the run is failed and its worktree path still exists on disk
- [ ] clicking the button triggers the mutation and navigates to the resulting new run
- [ ] the new run's detail view links back to the original run via the retry_of_run_id relationship

## Notes

Emitted by feature plan mpdvz63d: "feedback: Sometimes plans fail after exiting for an unknown reason and"

