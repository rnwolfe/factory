---
id: task-019
title: Wire codex into every headless invocation path identified in the parity
  inventory
status: done
priority: med
estimate: medium
created: 2026-05-25T17:43:24.864Z
updated: 2026-05-25T22:33:27.550Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] Each site listed in the parity-inventory document dispatches by agent kind and has a codex implementation (or is explicitly tagged `parity-blocked`)
- [ ] Per-site parity acceptance test from the inventory passes for every non-blocked site: triage approve, plan iterate, plan refine, bootstrap-from-plan, apply-feature-plan, apply-project-vision, audit iterate, audit exec-iterate, and feedback iterate all produce equivalent downstream effects under agent=codex
- [ ] Existing claude paths are byte-for-byte unchanged in behavior (regression-checked by running each path on a fixture project before and after the change)
- [ ] Ship-with-gap policy (operator-approved): `parity-blocked` sites do **not** block this task or the plan's freeze — they are documented in the inventory with gating reason + follow-up plan reference, and the PWA surfaces an actionable error if the operator selects agent=codex for a parity-blocked code path at run-spawn time

## Notes

Emitted by feature plan nt7386gu: "Full support for OpenAI Codex as an agent harness/model powering Factory/Heimdall. We could use either headless codex cli, or the codex sdk as long as it supports use of subscription usage and not just api key."


