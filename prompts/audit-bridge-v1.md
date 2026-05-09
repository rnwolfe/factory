# Factory Audit Bridge — Findings → action (v1)

You are deciding how an operator should act on the following audit findings.
The operator has selected these specific findings to address. Your output
routes them to either a draft plan (heavyweight: iterate then freeze) or a
bug task (lightweight: minimal capture, refine later).

## Inputs

- `{{PROJECT_NAME}}` — project name.
- `{{PROJECT_CEREMONY}}` — `tinker` | `personal` | `shared` | `production`.
- `{{INTENT_ROLE}}` — `owner` | `contributor` | `null`. For
  `contributor`-mode projects, default to `task_plan` even on
  feature-shaped findings — feature plans don't fit a contributor's PR
  scope.
- `{{PROJECT_VISION_EXCERPT}}` — short excerpt from VISION.md if present,
  else "(no vision doc)".
- `{{AUDIT_SKILL_NAME}}` — the audit skill that produced these findings.
- `{{FINDINGS_MARKDOWN}}` — the selected findings rendered as markdown
  (title, severity, body, optional file ref each).

## Procedure

Decide which path fits the selected findings:

1. Are these findings tractable as a single coherent unit of work?
   - **Yes** and the work is task-scoped (one or two files, narrow change):
     recommend `"plan"` with `planKind: "task_plan"`. Draft a goal statement.
   - **Yes** and the work spans multiple tasks / is feature-shaped:
     recommend `"plan"` with `planKind: "feature_plan"`. Draft a goal.
     **Exception:** if `INTENT_ROLE == "contributor"`, downgrade to
     `task_plan` regardless — contributor projects don't ship features.
   - **No**, or the work is too small to plan, or the findings need more
     analysis before a plan makes sense: recommend `"bug"`. Draft a one-
     paragraph task body and a short title.

The `reasoning` field is shown to the operator in the modal so they can
override the recommendation with context. Be specific about why; "this is
plan-shaped" is unhelpful.

## Output schema

Emit a single JSON object on stdout — no preamble, no commentary, no Markdown
fences. The first character of your response must be `{`.

```json
{
  "recommendation": "plan",
  "planKind": "task_plan",
  "goal": "string — plan goal, only when recommendation=plan",
  "taskTitle": null,
  "taskBody": null,
  "reasoning": "string — one paragraph explaining the choice"
}
```

Or for the bug path:

```json
{
  "recommendation": "bug",
  "planKind": null,
  "goal": null,
  "taskTitle": "string — short title (<80 chars)",
  "taskBody": "string — markdown body, one paragraph or so (<1500 chars)",
  "reasoning": "string — one paragraph explaining the choice"
}
```

## Rules

- This is a routing call, not a substantive analysis. Keep it short.
- Lean toward `"bug"` when in doubt — bugs can be promoted to plans later
  via refinement, but iterating a too-thin plan wastes iteration turns.
- Honor `INTENT_ROLE`. Contributor-mode never returns `feature_plan`.
- Output JSON only. The first character of your response must be `{`.
  No prose, no Markdown fences.
