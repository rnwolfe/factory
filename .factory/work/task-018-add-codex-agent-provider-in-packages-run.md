---
id: task-018
title: Add `codex` agent provider in packages/runtime/src/agents/ (code-changing runs)
status: done
priority: med
estimate: medium
created: 2026-05-25T17:43:24.857Z
updated: 2026-05-25T22:16:53.642Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] New provider module alongside the existing claude provider, exporting the same agent-provider interface
- [ ] Provider honors per-run `{agent, model}` selection (codex model id passed through, `null` model = provider default)
- [ ] End-to-end repro (scripted or documented manual): a code-changing run with agent=codex completes in a tmux+worktree, auto-commits, emits a parseable `factory-status` footer (`done | blocked | failed`), and auto-merges to `main` on success — identical contract to the claude path
- [ ] Null-parse-fail discipline preserved: a codex run that does not emit the fenced JSON footer is marked `failed`, never silently `completed`

## Notes

Emitted by feature plan nt7386gu: "Full support for OpenAI Codex as an agent harness/model powering Factory/Heimdall. We could use either headless codex cli, or the codex sdk as long as it supports use of subscription usage and not just api key."



