---
id: task-038
title: Render feedback triage as a suggestion card; hide raw fields, keep
  reasoning visible
status: ready
priority: med
estimate: small
created: 2026-06-14T11:04:55.814Z
updated: 2026-06-14T11:04:55.814Z
labels:
  - feedback
---

## Source

Captured from feedback z5jh6l16b68eutcjfzog5qcw (feedback-detail on /feedback/t17ij4dze5blhq4hugye9t74).

## Operator's note

Feedback landing in the inbox does get auto triaged well, and suggested as a plan or task with explanation - but this isn’t really integrated. It is just the raw output of the prompt landing as a comment.. can we improve this?

## Agent's draft

In `feedback-detail.tsx`, when a comment has a `resultingDraft`, render a structured suggestion card (kind chip + title + summary) as the primary UI and suppress the raw structured payload. Keep `reasoning` evident as readable explanatory text attached to the card (inline or one-tap expand), not as the headline. Bind `promoteToPlan`/`promoteToTask` to that specific card. Backend draft + promote endpoints already exist; render + interaction wiring only.

## Acceptance

- [ ] (TBD)
