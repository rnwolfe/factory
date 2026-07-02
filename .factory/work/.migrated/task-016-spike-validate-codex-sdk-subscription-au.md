---
id: task-016
title: "Spike: validate codex SDK subscription auth in headless mode (CLI is the
  fallback)"
status: done
priority: med
estimate: medium
created: 2026-05-25T17:43:24.836Z
updated: 2026-05-25T17:50:55.625Z
labels:
  - feature-plan-task
model: claude-sonnet-4-6
---

## Acceptance

- [ ] Decision recorded in an ADR (`docs/adr/NNN-codex-harness.md`) — defaults to SDK; only falls back to CLI if SDK cannot authenticate via ChatGPT subscription in a non-interactive systemd-managed daemon context
- [ ] Proof — a working one-shot prompt invocation via codex SDK that returns text, authed via ChatGPT subscription (no API key in env)
- [ ] Proof — a working long-running / streamed invocation via codex SDK suitable for the tmux+worktree run pattern, authed the same way
- [ ] Confirms (or rules out) sandbox posture equivalent to `--dangerously-skip-permissions` and identifies whatever flag/mode codex exposes for non-interactive code-changing work
- [ ] If the SDK fails the subscription-auth check, the ADR documents why and the spike re-runs against the CLI before committing to a path

## Notes

Emitted by feature plan nt7386gu: "Full support for OpenAI Codex as an agent harness/model powering Factory/Heimdall. We could use either headless codex cli, or the codex sdk as long as it supports use of subscription usage and not just api key."




