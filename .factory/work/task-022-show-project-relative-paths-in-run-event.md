---
id: task-022
title: Show project-relative paths in run event log (strip worktree prefix)
status: ready
priority: med
estimate: small
created: 2026-06-11T12:20:04.051Z
updated: 2026-06-11T12:20:04.051Z
labels:
  - feedback
---

## Source

Captured from feedback n4vp2roa5fmvn3r0mix3fijv (run-pane on /projects/kxsocpgivti6mjbvuqt5my6i/runs/t5z4nsdvwgqr90cmm3mf4pdc).

## Operator's note

In the run log of agent events, any read type task shows the full path of the directory which is very long due to factory worktree locations. Can we truncate the path so the event is meaningful in showing the project relevant path?

## Agent's draft

In the agent event stream, tool events (Read/Edit/Write) render the full absolute worktree path (`~/.factory/worktrees/<slug>/<runId>/...`), burying the meaningful part under the 80-char cap. Relativize the path against the run's worktree root when the `tool` event's `argSummary` is built (`summarizeToolInput` in `claude-code.ts`, or at emit time in `runner.ts` which has the worktree root), so stored summaries are already project-relative. Keep the UI renderer (`run-event-row.tsx:99`) unchanged.

## Acceptance

- [ ] (TBD)
