---
id: task-046
title: Rescue committed work when codex omits the factory-status footer
status: done
priority: high
estimate: small
created: 2026-06-20T05:00:00.000Z
updated: 2026-06-20T05:00:00.000Z
labels:
  - audit
  - codex
---

## Source

Prod-usage audit (14d ending 2026-06-20). Finding F2. See `tasks/audit-prod-14d-2026-06-20.md`.

## Operator's note

codex runs that do real, auto-committed work but emit the wrong sign-off block
(or no `factory-status` footer) are marked `failed`, discarding the committed
code. This is distinct from the codex+claude-model fast-fail (already fixed by
`21c0cb6`); these runs ran for minutes and committed real work.

## Evidence

Two runs on the live host, both AFTER the F1 clamp fix, so not model-mismatch:

- `t722xnwh3wts6x1xzz8fjqh5` — factory, 2026-06-14 22:43, 432s. Implemented snooze
  mutations across decisions/plans/audits/feedback, ran tests, auto-committed
  (`chore: auto-commit residual changes`), exited `exitCode 0` → marked **failed**.
  Metrics show `inputTokens: 911489` of real spend.
- `vc7h1nbfmrw8hv2jyomwgrpf` — factory, 2026-06-14 23:32, failed the same way.
- Earlier `woxib1...` (06-13) emitted a ```` ```factory-decision ```` block
  instead of `factory-status`.

Root cause: the factory-status parser null-parses codex output (codex is less
reliable at reproducing the fenced footer than claude-code) → run marked
`failed` per the honesty contract, even though commits provably landed.

## Agent's draft

In the runner's status-resolution path (`apps/daemon/src/workers/runner.ts` +
parser `apps/daemon/src/workers/factory-status.ts`): when the footer parse is
null BUT `exitCode === 0` AND the run produced commits on its branch, resolve to
a new terminal state `needs_review` (operator-surfaced, inbox decision) instead
of `failed`. Never silently auto-merge it — it lands in the inbox for an
explicit operator call.

This *softens, does not weaken*, the honesty contract: it only rescues the
provable-work case. A null parse with no commits stays `failed` exactly as today.

Secondary: harden footer compliance on the codex code path specifically (the
prompt footer wrap may need stronger/again-at-end reinforcement for codex). See
`docs/adr/006-codex-harness.md`.

## Acceptance

- A codex run with `exitCode 0`, missing/invalid footer, and ≥1 commit on its
  branch resolves to `needs_review`, surfaced in the inbox, code preserved on
  the branch (not discarded, not auto-merged).
- A run with null footer and zero commits still resolves to `failed`.
- The `factory-status` null-parse-fail contract for claude-code runs is
  unchanged (regression-test it).
- Add a test covering the {exitCode 0, no footer, has commits} → needs_review path.
