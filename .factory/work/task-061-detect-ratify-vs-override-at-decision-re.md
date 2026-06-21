---
id: task-061
title: Detect ratify-vs-override at decision-resolve time
status: ready
priority: med
estimate: medium
created: 2026-06-21T12:21:55.369Z
updated: 2026-06-21T12:21:55.369Z
labels:
  - feature-plan-task
sourcePlanId: xffdowhwtks03o1dvowic1l1
---

## Acceptance

- [ ] The decision-resolve path distinguishes 'operator ratified the agent's proposed answer' from 'operator chose a different option or supplied a custom answer'.
- [ ] Any non-ratification (different option OR custom answer) emits a resurfacing signal; ratification behaves exactly like accept — written back, work stays closed, no follow-up.
- [ ] No agent judgement of materiality is involved — the resurfacing trigger is solely the operator's ratify-vs-override choice.

## Notes

Emitted by feature plan xffdowhw: "Adjusted decisions must resurface for implementation, not silently close"

