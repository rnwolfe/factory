---
name: drift-check
description: Compare the most recent task run's actual touched files against its frozen task_plan's declared touches; flag drift.
kind: exec
needs_worktree: true
default_severity_grade: enabled
---

# drift-check

You are detecting **scope drift** in code-changing runs. A frozen
`task_plan` declares a `touches` list — files the agent expects to modify.
If the run's actual touches went outside that list, the drift is worth
surfacing — sometimes it's necessary scope adjustment, sometimes it's
unauthorized expansion.

This skill is `kind: exec` because it needs shell access to run
`git log`, `git show`, and `git diff` against the project's worktree to
compute the actual touch set. The framework will provide the recent
commit log in the project context, but the per-commit file list comes
from your shell calls.

## Scope

Read the most recent **completed** run on a task that had a frozen
`task_plan` attached at submission time. Identify it via:

- `git log -n 30 --format='%h %s'` — look for `factory: merge <task-id>`
  subjects that mark a successful run merge into main.
- For the chosen merge commit, `git log -1 --format=%H <sha>` and the
  associated `factory/run-<runId>` branch (visible via `git branch --all`).
- Cross-reference the run's frozen task_plan in
  `<project>/.factory/work/<task-id>-*.md` (the task body holds the
  acceptance the run was executing against; the plan's `touches` list
  itself is in Factory's DB and exposed via the project context the
  framework injects below).

If the framework didn't surface the plan's `touches` for the most recent
run, declare `blocked` with a question — don't guess.

## Report shape

The audit framework's two-block envelope handles the report shape: the
`factory-audit-report` fence carries operator-readable text, and the
`findings` JSON carries the structured array. Inside the report:

- `## Summary` — name the run id, the task, and the headline result.
- `## Declared vs actual` — list the plan's declared `touches` and the
  actual files modified, side by side or as two sub-lists.
- `## Findings` — one `### <severity>: <title>` per drift entry per
  the rules below.

A clean run is `"findings": []` with a short report saying so.

## What to look for

1. **Files touched outside the declared `touches` list.** Each is a
   finding. Severity depends on the file:
   - **major**: changes to auth / runtime / migration / schema files not
     declared
   - **minor**: changes to peripheral files (docs, fixtures, tests)
2. **Files declared but not touched.** Less critical, but worth flagging
   as **enhancement** — was the plan over-scoped, or did the run skip
   intended work?
3. **Pattern: drift cluster.** If 3+ findings all hit the same module,
   that's a single **major** finding — the agent's mental model of scope
   was wrong, not the operator's.

## Procedure (you have shell access)

1. Identify the most recent factory-merged commit and its underlying run
   via `git log` as above.
2. `git show --stat <merge-sha>` to enumerate the actual touched paths.
3. Cross-reference against the plan's declared `touches` list (from the
   project context).
4. Walk the diff between declared and actual; emit one finding per
   drift entry per the severity guide.

A clean run with no drift is `"findings": []` and a short report saying so.
