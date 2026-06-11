---
id: task-025
title: Auto-triage feedback items on inbox arrival instead of requiring a reply
status: ready
priority: med
estimate: small
created: 2026-06-11T12:35:48.963Z
updated: 2026-06-11T12:35:48.963Z
labels:
  - feedback
---

## Source

Captured from feedback gacrevgp2hfytibfdcjwz7zy (feedback-detail on /feedback/fp06wh48npb67vwq1uu6eoir).

## Operator's note

When a factory feedback item lands in the inbox, it should automatically triage with an agent. Right now, I have to send some additional reply to trigger this. 

## Agent's draft

Bind the existing feedback-triage agent to the inbox-arrival event so a new feedback item triages itself automatically. Today triage only fires on a subsequent reply, leaving items inert until manually nudged.

Reuse the current triage path — don't fork it. Add an idempotency guard so an item isn't triaged twice (e.g. arrival + later reply) and an already-routed item isn't re-triaged.

## Acceptance

- [ ] (TBD)
