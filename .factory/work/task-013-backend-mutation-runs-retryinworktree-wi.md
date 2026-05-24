---
id: task-013
title: "Backend mutation: runs.retryInWorktree with continuation preamble"
status: ready
priority: med
estimate: medium
created: 2026-05-24T01:46:25.607Z
updated: 2026-05-24T01:46:25.607Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] mutation rejects runs whose status is not failed
- [ ] mutation rejects runs whose worktree no longer exists on disk
- [ ] the spawned run's prompt is the original task prompt prefixed with a continuation preamble naming the orphaned-state recovery procedure (inspect git status + recent commits, then continue from inside the worktree)
- [ ] the resulting run row sets retry_of_run_id to the original run id

## Notes

Emitted by feature plan mpdvz63d: "feedback: Sometimes plans fail after exiting for an unknown reason and"

