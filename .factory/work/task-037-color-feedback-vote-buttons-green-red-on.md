---
id: task-037
title: Color feedback vote buttons green/red on select in feedback-drawer
status: done
priority: med
estimate: small
created: 2026-06-14T11:01:21.615Z
updated: 2026-06-14T11:11:48.246Z
labels:
  - feedback
---

## Source

Captured from feedback srhe5lbksmd0ge93cwp4l3f8 (task-detail on /projects/nhhr6ehysl0mi2rq0mnmo8db/tasks/task-034).

## Operator's note

On the feedback form, the works for me vs friction button should be green vs red on select to be more intuitive

## Agent's draft

In `apps/pwa/src/components/feedback-drawer.tsx`, make the selected vote state semantically colored: "works for me" → green, "friction" → red. Reuse an existing `--color-verdict-*` token for green rather than hardcoding; friction already uses `--color-verdict-trashed` (red). Strengthen beyond the 1px border — tint icon/text (and optionally a faint bg) so the selected affordance is legible on the warm-dark surface. Verify both states at 390px.

## Acceptance

- [ ] (TBD)

