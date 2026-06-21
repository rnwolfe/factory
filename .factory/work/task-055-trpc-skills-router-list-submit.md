---
id: task-055
title: tRPC `skills` router — list + submit
status: ready
priority: med
estimate: small
created: 2026-06-21T12:15:59.194Z
updated: 2026-06-21T12:15:59.194Z
labels:
  - feature-plan-task
sourcePlanId: am7ozbki925cvw61ne66zqq9
---

## Acceptance

- [ ] `skills.list({ projectId })` returns the discovered skills for a project, keyed by project id
- [ ] `skills.submit({ projectId, skillName })` creates a run for the named skill, mirroring `audits.submit`
- [ ] Submit resolves the project's fused `{agent, model}` via the standard resolution chain (project → settings → default)

## Notes

Emitted by feature plan am7ozbki: "Surface project skills on the project page with harness-agnostic execution"

