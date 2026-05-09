---
name: code-review
description: Review the most recent merged commits for logic errors, security issues, convention adherence, and test coverage gaps.
kind: exec
needs_worktree: true
default_severity_grade: enabled
---

# code-review

You are auditing the most recent merged work in this project. Your output is
a structured report that will be reviewed by the operator and (on approval)
committed to the project repo as project doctrine. **Be honest.** A clean
report with no findings is a valid and useful result; do not invent issues
to look productive.

## Scope

Read the **last ~5 merged commits to `main`** (skip merge commits whose only
change is `--no-ff` of a feature branch — go to the underlying commits).
Diff each one to understand what changed; pull in surrounding context as
needed.

## What to look for

For each commit / change set, evaluate:

1. **Logic errors.** Does the code do what the commit message claims? Is
   there an obvious bug — off-by-one, wrong condition, missing null check,
   incorrect error path? Pin the line.
2. **Security concerns.** Anything that takes user input and reaches a sink
   (SQL, shell, file path, network call)? Any new secret handling? Any
   permission / authn / authz gates added or weakened?
3. **Convention adherence.** Does the change respect the project's
   `CLAUDE.md` architectural contracts? If the contract reads "X always wraps
   Y" and the change skips the wrap, that's a finding.
4. **Test coverage gaps.** Did the change add behavior that has no test?
   Did it modify existing behavior that previously had a test, but the test
   was not updated? Surface the gap; do not write the test.

## Report shape

The audit framework's two-block envelope handles the report shape: the
`factory-audit-report` fence carries operator-readable text, and the
`findings` JSON carries the structured array.

Inside the report fence:

- A `## Summary` section: one paragraph naming what you reviewed (which
  commits, what scope) and the headline result (clean / N findings).
- A `## Findings` section: one `### <severity>: <title>` per finding,
  with the body explaining what's wrong and (when applicable) the
  file path + line. If there are no findings, write `No findings.` and
  the structured `findings` array is `[]`.
- Optional `## Notes` if there's reviewer commentary that didn't rise
  to a finding.

`findings` is the structured array — one finding per issue. Pin the file +
line where applicable. Use the framework severity guide (critical / major
/ minor / enhancement) — it's already in the output-contract footer the
framework appends, so you don't need to re-state it in the report unless
your skill diverges.

## Procedure (you have shell access)

1. `git log --no-merges -n 10 --pretty=format:"%H %s"` — pick the most
   recent ~5 changes that aren't bootstrap / chore-only.
2. For each: `git show <sha>` and (when needed) `git diff <sha>~1 <sha> -- <file>`.
3. Read referenced files at HEAD to confirm the change is still in the tree
   (a follow-up may have already reverted it).
4. Optionally run `bun test` or `bun run typecheck` to confirm the merged
   work still passes — if it doesn't, that's a critical finding.

The factory-status footer is added automatically; declare `done` when the
report is complete.
