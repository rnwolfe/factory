---
id: task-021
title: "Spike: re-evaluate Codex SDK at developers.openai.com/codex/sdk against
  subscription auth (revisit ADR-006)"
status: ready
priority: med
estimate: medium
created: 2026-05-25T21:38:57.511Z
updated: 2026-05-25T21:38:57.511Z
labels:
  - refinement-followup
parent: task-016
---

## Acceptance

- [ ] (TBD)

## Notes

Follow-up emitted by refinement plan against task-016. Operator note: Operator disputes the prior spike's conclusion that no importable Codex SDK exists, citing https://developers.openai.com/codex/sdk as evidence of an official SDK that was not evaluated. The prior run investigated the `@openai/codex` npm package and found only a CLI surface; the URL the operator provided appears to point to a distinct SDK product (likely a different package or distribution) that the spike never opened. Operator wants the SDK path re-investigated against that specific documentation before CLI-only is locked in.

