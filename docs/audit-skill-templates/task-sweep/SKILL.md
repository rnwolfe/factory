---
name: task-sweep
description: Score every open task in .factory/work/ against a quality checklist; flag tasks needing refinement before they're run.
kind: read-only
needs_worktree: false
default_severity_grade: enabled
---

# task-sweep

You are auditing the project's open tasks for **runnability**. A run kicks
off without a human in the loop, so a task that lacks specifics produces
unsatisfying results and ties up an iteration cycle. Better to flag it now
and prompt the operator to refine it.

## Scope

Read every task file under `<project>/.factory/work/*.md` whose status is
`ready` (other statuses are out of scope — `in_progress` is mid-flight,
`done` is merged, `blocked` already needs operator attention).

## Checklist (per task)

Score each task against these criteria. Each "no" becomes a finding for
that task.

1. **Title is specific.** Not "improve X" or "fix bug" — names *what*
   improvement / *which* bug.
2. **Acceptance criteria are checkable facts.** "Returns 200 on valid
   payload" not "looks good." 1+ criteria; the more the better, up to
   ~5.
3. **Acceptance criteria don't say `(TBD)`.** That's a placeholder; the
   task is unfinished work-of-planning, not work-of-execution.
4. **Estimate is set.** `small`/`medium`/`large` are the only options;
   missing == unestimated.
5. **Body has context.** A `## Notes` section or similar explaining *why*
   this work matters or what tripped over the planner. Tasks with only
   acceptance and no notes often produce literal-acceptance-met but
   spiritually-wrong runs.
6. **No dangling parent reference.** If `parent: task-NNN` is set, that
   parent should exist (and not be `dropped`).

## Report shape

`reportMarkdown`: per-task walkthrough — task id + title, then any flags.
End with a one-line summary: "N tasks flagged out of M."

`findings`: one entry per **per-task** issue. The `filePath` should be the
task file's relative path; `line` is null. Severity guide:

- **major**: acceptance is `(TBD)` or missing; title is "fix X" without
  specifics. The task as written can't be run.
- **minor**: missing estimate, missing notes section. Runnable but thin.
- **enhancement**: phrasing improvements, "looks good"-style criteria.

A clean sweep is `"findings": []` with a short report saying so.

## Procedure

You're read-only — no shell. Read each task body via the project context.

Operators typically promote findings to **bugs** (one bug per task or a
batched bug for "refine all flagged tasks") rather than plans. The bug is
the "remember to refine this" reminder; the actual refinement is a
separate `refinement` plan.
