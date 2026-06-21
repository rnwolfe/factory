---
id: task-063
title: "GitHub-Issue backend: reopen work via linked follow-up issue"
status: ready
priority: med
estimate: medium
created: 2026-06-21T12:21:55.397Z
updated: 2026-06-21T12:21:55.397Z
labels:
  - feature-plan-task
sourcePlanId: xffdowhwtks03o1dvowic1l1
---

## Acceptance

- [ ] On a github-issues-backed project, an operator override creates a new follow-up issue that links back to the original closed issue; the original issue stays closed.
- [ ] The mechanism is consistent with the ADR-007 issue-backend contract (the follow-up issue is the new task; the link makes the thread traceable).
- [ ] The operator's chosen/custom answer is carried into the follow-up issue body so the implementer sees what to build.

## Notes

Emitted by feature plan xffdowhw: "Adjusted decisions must resurface for implementation, not silently close"

