---
id: task-020
title: Per-project `{agent, model}` picker, run-time override, and subscription
  auth onboarding
status: done
priority: med
estimate: medium
created: 2026-05-25T17:43:24.868Z
updated: 2026-05-26T03:05:20.709Z
labels:
  - feature-plan-task
---

## Acceptance

- [ ] Schema migration replaces the bare per-project model field with a fused `{agent, model}` shape (Drizzle Kit generated; existing rows backfill to `{agent: 'claude', model: <prior value>}`)
- [ ] Project settings UI exposes the fused picker; decision-approve and other run-spawn entry points let the operator override `{agent, model}` for that run
- [ ] `factory doctor` reports codex auth status when any project is configured for `agent=codex` (or when codex is selected at run time)
- [ ] README + CLAUDE.md updated to describe the codex subscription auth setup (one-time login flow, where credentials live, how the systemd-managed daemon accesses them, how to rotate)
- [ ] Failure mode when codex is selected but not authed — or selected on a parity-blocked path — surfaces as an actionable error in the PWA at run-spawn time, not a silent mid-run failure

## Notes

Emitted by feature plan nt7386gu: "Full support for OpenAI Codex as an agent harness/model powering Factory/Heimdall. We could use either headless codex cli, or the codex sdk as long as it supports use of subscription usage and not just api key."





