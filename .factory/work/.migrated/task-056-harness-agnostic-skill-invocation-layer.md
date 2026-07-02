---
id: task-056
title: Harness-agnostic skill invocation layer
status: done
priority: med
estimate: large
created: 2026-06-21T12:15:59.207Z
updated: 2026-06-21T12:33:21.545Z
labels:
  - feature-plan-task
sourcePlanId: am7ozbki925cvw61ne66zqq9
---

## Acceptance

- [ ] A skill run injects the resolved SKILL.md body into the run prompt rather than relying on the CLI's native skill mechanism
- [ ] The same skill executes on both a `codex`-configured and a `claude-code`-configured project
- [ ] Execution reuses `runtime.spawn` (per-run worktree, `factory-status` footer, auto-commit/auto-merge) like any code-changing run — no new bypass path

## Notes

Emitted by feature plan am7ozbki: "Surface project skills on the project page with harness-agnostic execution"


