---
id: task-034
title: Surface project association on inbox decision cards and detail view
status: ready
priority: med
estimate: small
created: 2026-06-14T10:57:45.690Z
updated: 2026-06-14T10:57:45.690Z
labels:
  - feedback
---

## Source

Captured from feedback l6ojnco4ecvpebqdaycw8ygj (inbox on /).

## Operator's note

Things landing in inbox don’t indicate what project they are related to in their card or detailed view. 

## Agent's draft

Add a project chip to the inbox decision card and detail pane, sourced from the existing `decisions.projectId`. Backend: join project name in `decisions.inbox` (decisions.ts:136) like the audits path already does. Frontend: render the chip in `decision-card.tsx` and `inbox-detail-pane.tsx`. Triage ideas have no project linkage in the data model, so render an explicit 'no project yet / triage' state for those rather than a project name.

## Acceptance

- [ ] (TBD)
