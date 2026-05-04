---
name: drift-check
description: Compare the most recent task run's actual touched files against its frozen task_plan's declared touches; flag drift.
kind: read-only
needs_worktree: false
default_severity_grade: enabled
---

# drift-check

You are detecting **scope drift** in code-changing runs. A frozen
`task_plan` declares a `touches` list — files the agent expects to modify.
If the run's actual touches went outside that list, the drift is worth
surfacing — sometimes it's necessary scope adjustment, sometimes it's
unauthorized expansion.

## Scope

Read the most recent **completed** run on a task that had a frozen
`task_plan` attached at submission time. Extract:

- The frozen plan's declared `touches: string[]`.
- The actual files modified by the run's commits (use the commit list /
  diff that surfaces in the run summary; failing that, name the run id and
  ask the operator to provide the diff in a follow-up comment).

If no such run exists in the project, that's a clean result — emit a
short report saying so.

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

## Report shape

`reportMarkdown`: name the run id, the task, the declared touches, the
actual touches, then the diff (which list-items differed). Findings
follow the per-file flags.

A clean run with no drift is `"findings": []`.

## Procedure

Read-only. Use the project context and run metadata. If you need more
detail than the prompt provided, declare `blocked` with a single specific
question.
