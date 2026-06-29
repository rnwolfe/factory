# ADR-018 · Verification-infrastructure health — couldn't-run ≠ failed, and self-heal it

**Status:** proposed (2026-06-29) — **draft for operator review**
**Scope:** extends the Verifier-Coverage Gate (ADR-014) and feeds the Watch/proposal
primitive (ADR-010/011). Came out of a live lodestar run whose "quality FAIL" was
actually a quality check that *couldn't execute*.

## Context

A run on lodestar surfaced as a quality **failure**. The stored report:

```json
{"name":"config","command":"(loading quality.yaml)","exitCode":1,"durationMs":0,
 "stderrTail":"ENOENT: no such file or directory, posix_spawn 'sh'"}
```

The project's quality config was **fine**. The check **never ran** — the worktree had
been reclaimed (a 0-commit run) so the command spawned in a missing directory. But the
verifier scored it identically to a check that *ran and failed*. That conflation is the
problem, and it generalizes well beyond the 0-commit case (a missing `make` target, an
uninstalled tool, a typo'd command, a bad `PATH` in the daemon's unit — all "can't
execute"):

1. **It masquerades as a code defect.** A `fail` signal is "actionable" (ADR-016 slice 4),
   so it **triggers the auto-retry loop** — but the agent cannot fix a missing `sh` or a
   broken Makefile by re-running its *code*. The loop re-runs, fails identically, and burns
   the whole budget. Pure churn, and a polluted `auto_retry_exhausted` signal.
2. **It hides the real problem.** "Quality failed" reads as "your code is bad." The truth is
   "your verification tooling is broken" — a *setup* issue, invisible under the wrong label.
3. **It corrupts the autonomy signal.** A project whose checks can't run scores `none`
   forever → can never reach `high` → can never earn or keep autonomy, for a reason that has
   nothing to do with its code.

The verifier's coverage model is already three-state — `pass` / `fail` / **`absent`**
(ADR-014: "nothing checked this"). "Couldn't run" is conceptually `absent` (it verified
nothing), not `fail`. We just never distinguished a check that *chose* not to run from one
that *tried and couldn't*.

## Decision

**A verification check that cannot execute is infrastructure-broken, not a quality verdict.
Classify it, score it as `absent`, surface it as a setup problem, and let the Watch propose
a fix.**

1. **Three execution outcomes, not two.** The quality/verifier runner tags each check:
   - `ran_passed` — process executed, exit 0.
   - `ran_failed` — process executed, non-zero exit (a real quality signal).
   - `could_not_run` — the process never executed: a spawn error (`ENOENT`/`EACCES`),
     `command not found`, a 0ms non-zero with no output, or a missing cwd. This is the new
     state; it's detectable from the spawn result, not heuristics on output.

2. **`could_not_run` maps to `absent` in the verifier**, never `fail`. So it scores zero
   (didn't verify) but is **not an actionable defect** — it never triggers auto-retry, never
   contracts trust, never reads as a code problem.

3. **Surface it as verification-infrastructure health**, distinct from a code review item: a
   `verification_broken` signal on the run + an autonomy event, so the operator sees "lodestar's
   `lint` check can't execute — `make: lint: No such target`," not a buried quality fail.

4. **Self-heal (the loop the operator asked for).** A project with **persistent**
   `could_not_run` results across recent runs is a Watch/audit signal → propose a repair task
   ("lodestar's quality checks can't execute — fix `.factory/quality.yaml` / the Makefile").
   Operator approves → a run fixes the project's **own tooling**. Factory self-improving its
   *substrate*, not just shipping features — and it generalizes to every repo.

## Contracts (don't break)

- **`could_not_run` is never a code defect.** It must not auto-retry, must not contract the
  Trust Ladder, must not surface as a quality failure. It is a setup problem with its own lane.
- **Classification is mechanical, not heuristic.** Use the spawn/exec signal (spawn error,
  ENOENT, command-not-found, missing cwd), not guesses about output. A check that genuinely
  runs and fails fast (a lint erroring in 5ms *with* output) is `ran_failed`, not broken.
- **Self-heal proposals are operator-gated** (inbox), like every Watch proposal — not auto-run,
  until/unless Phase C (ADR-017) graduates a "repair-tooling" class. A repo that can't verify
  itself is the *last* place to auto-merge unattended.

## Build sequence

1. **Classify** — `workers/quality.ts`: tag results `could_not_run` on spawn failure / ENOENT /
   missing-cwd / command-not-found, separate from `ran_failed`. (The 0-commit case is already
   skipped as of v0.38.2; this catches the *general* misconfig on real runs.)
2. **Score** — `workers/verifier.ts`: a `could_not_run` quality signal contributes `absent`,
   not `fail`; `hasActionableDefect` excludes it (so no auto-retry).
3. **Surface** — a `verification_broken` signal on the run + an autonomy event (digest), and the
   "held for review" card frames it as a setup problem with the failing command + error.
4. **Self-heal** — a Watch check (or a tiny audit) that flags projects with persistent
   `could_not_run`, emitting a repair proposal into the inbox.

## Open questions (for the operator)

1. **Persistence threshold** — how many `could_not_run` results (over what window) before a
   repair proposal? (Lean: ≥2 consecutive runs, per project, deduped so it proposes once.)
2. **Proposal shape** — a task, a bug, or an audit finding? (Lean: a bug — it's a defect in the
   project's tooling, and bugs already promote to runs.)
3. **Does a `could_not_run` still surface the run for review, or complete it quietly?** If the
   *only* issue is broken infra (no real `ran_failed`), the code may be fine — surface the
   *infra* problem, but should the run itself hold or land? (Lean: hold once, with the infra
   framing, so nothing merges unverified — but don't auto-retry it.)
