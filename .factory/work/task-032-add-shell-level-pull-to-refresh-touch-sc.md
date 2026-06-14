---
id: task-032
title: Add shell-level pull-to-refresh (touch, scroll-at-top → invalidate active
  queries)
status: ready
priority: med
estimate: small
created: 2026-06-14T10:41:34.232Z
updated: 2026-06-14T10:41:37.224Z
labels:
  - feedback
model: claude-sonnet-4-6
---

## Source

Captured from feedback sozqrikyo4e014maxs82ot6r (project-detail on /projects/l0bbq6nns5rv8o5v2mrfqofq).

## Operator's note

Add pull down to refresh

## Agent's draft

Add pull-to-refresh as an app-shell affordance so every route inherits it, not just project-detail. On touch drag past the top of the scroll container, invalidate the active React Query observers (`invalidateQueries`, `refetchType: 'active'`) so the current route's data refetches without per-route wiring.

Gate on touch + scroll-at-top so desktop pointer scrolling and normal mobile scrolling are unaffected (honors the mobile invariant). Mount it in the responsive Shell so it coexists with bottom-nav and route scroll containers. Indicator should match the warm-dark/amber dispatcher aesthetic.

## Acceptance

- [ ] (TBD)

