---
id: task-062
title: Backend-agnostic resurfacing seam
status: ready
priority: med
estimate: medium
created: 2026-06-21T12:21:55.384Z
updated: 2026-06-21T12:21:55.384Z
labels:
  - feature-plan-task
sourcePlanId: xffdowhwtks03o1dvowic1l1
---

## Acceptance

- [ ] Resurfacing is driven through one seam that both the local-file task backend and the GitHub-Issue backend implement, so non-GitHub projects re-queue overridden work too.
- [ ] A non-GitHub (local-file) project where the operator overrides the agent's answer produces a re-queued unit of work the operator can see and act on.
- [ ] The seam preserves the link from the resurfaced work back to the originating decision for audit trail.

## Notes

Emitted by feature plan xffdowhw: "Adjusted decisions must resurface for implementation, not silently close"

