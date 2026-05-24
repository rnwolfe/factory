---
id: task-012
title: "Runtime: support reusing an existing worktree on spawn"
status: ready
priority: med
estimate: medium
created: 2026-05-24T01:46:25.600Z
updated: 2026-05-24T01:46:25.600Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] runtime.spawn accepts an existing worktree path and skips fresh worktree + branch creation when provided
- [ ] missing-worktree / missing-branch cases raise a clear error rather than silently falling back to fresh-worktree behavior
- [ ] the tmux session for the run targets the existing worktree directory

## Notes

Emitted by feature plan mpdvz63d: "feedback: Sometimes plans fail after exiting for an unknown reason and"

