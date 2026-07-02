---
id: task-026
title: Add ⋯ overflow menu on plan-detail for abandon/archive across all statuses
status: done
priority: med
estimate: small
created: 2026-06-13T12:54:54.702Z
updated: 2026-06-13T13:07:05.777Z
labels:
  - feedback
---

## Source

Captured from feedback kj01v068drqojec3kscynvhd (plan-detail on /plans/kxoigzi96k4qcvde7hratzg6).

## Operator's note

There is nowhere to drop a plan/refinement?

## Agent's draft

Add a three-dots overflow menu to the plan-detail header, available regardless of `isDrafting`. Move the existing draft `abandon` action into it, and add an `archive` entry for `frozen`/`superseded` plans (broaden `plans.abandon` or add an `archive` mutation/status as needed). Keep per-status confirm copy honest ("abandon this draft" vs "archive this plan"); ensure refinement-kind plans expose the menu identically.

## Acceptance

- [ ] (TBD)

