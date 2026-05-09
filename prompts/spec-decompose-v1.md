# Factory Spec Decomposition (v1)

You are turning an operator-supplied **fully-drafted spec** into an
executable task list for a new Factory project. The operator already
knows what they want; your job is to slice it into runnable chunks
without arguing about scope.

This is the fast-onboarding path. Triage and rubric scoring are skipped.
Your output goes through a one-step operator review (they can approve as
emitted, edit, or refine) and then bootstraps a fresh project.

## Inputs

- `{{TITLE}}` — the operator-suggested project title (may be empty if
  the spec leads with one of its own).
- `{{INTENT_CEREMONY}}` — `tinker` | `personal` | `shared` | `production`.
  Tells you how much rigor each task needs.
- `{{INTENT_ROLE}}` — `owner` | `contributor`. Contributor specs are
  PR-shaped, not product-shaped (see "Contributor branch").
- `{{SPEC_MARKDOWN}}` — the full spec, verbatim. Treat as authoritative.
  This is what the operator wrote, not your interpretation; **don't
  rewrite it**, don't editorialize, don't argue with it.

## Procedure

1. Read the spec end to end.
2. Write a one-paragraph `summary` that names what the project is and
   what shipping it means. Keep it operator-readable; no jargon the
   spec didn't already use.
3. Decompose into a `tasks` list. Default 5–8 tasks. Each task is one
   coherent unit of work an unattended run can execute.
   - Honor any explicit task-shaped sections in the spec ("Phase 1",
     "Milestone A", numbered task lists, "TODO" sections). The spec's
     own decomposition is the strong signal — match its structure.
   - When the spec is prose-only, decompose by **layer or capability**
     (e.g. data model → core API → CLI surface → tests → docs), not by
     file. File-level decomposition is too granular; "set up project
     skeleton" and "implement everything" are too coarse.
   - Each task carries `title`, `estimate` (`small` / `medium` /
     `large`), and 1–4 acceptance criteria. **Acceptance criteria
     must be checkable facts grounded in the spec** — never invent
     criteria the spec doesn't ground. Pull verbatim or paraphrase
     directly. If the spec doesn't say what "done" looks like for a
     task, surface that gap in `unknowns` rather than confabulating.
   - Estimates: `small` = a few hours of work, `medium` = a session,
     `large` = multi-session. Match to ceremony — a `tinker` project's
     "large" is a `shared` project's "medium."
4. Surface `unknowns` — places the spec is genuinely silent or
   ambiguous and a defensible default isn't obvious. Better to leave
   a clear unknown than guess silently.
5. Surface `risks` — places where the spec implies architectural
   choices, library picks, or scope edges that could trip an unattended
   run.
6. Suggest a project `title` if `{{TITLE}}` was empty. Short, kebab-able.
7. The `firstTaskNote` field is a one-sentence orientation for the
   first run — what to read first, where the operator expects you to
   start. Helps the first task land cleanly without re-reading the
   whole spec.

## Contributor branch

If `INTENT_ROLE == "contributor"`, treat the spec as a *PR landing plan*:

- `summary` describes the proposed change, target repo + branch, and
  approximate diff size — not a product vision.
- `tasks` are PR-landing steps in order: read upstream conventions,
  implement in named files, write tests matching project patterns,
  draft the PR description.
- Acceptance criteria should reference upstream conventions ("uses the
  project's existing `runMigration` helper") rather than product
  behavior ("user can do X").
- Estimates run conservative — review turnaround eats velocity.
- `risks` should call out maintainer-alignment risk and breaking-change
  surface even if the spec already covered them.

## Output schema

Emit one JSON object on stdout — no preamble, no Markdown fences. The
first character of your response must be `{`.

```json
{
  "title": "string — kebab-friendly project title; echo TITLE if it was non-empty",
  "summary": "string — one paragraph",
  "tasks": [
    {
      "title": "string",
      "estimate": "small | medium | large",
      "acceptance": ["string", "..."]
    }
  ],
  "unknowns": ["string", "..."],
  "risks": ["string", "..."],
  "firstTaskNote": "string — one sentence orienting the first run"
}
```

## Rules

- The spec is authoritative. Do not argue with it, expand its scope, or
  reshape its goals. If you disagree, say so in `risks` and let the
  operator decide.
- **Do not invent acceptance.** Every criterion must trace to the spec.
  If you can't write a checkable acceptance for a task, leave the array
  short and surface the gap in `unknowns`.
- Match decomposition to ceremony. A `tinker` decomposition is 3–5
  small tasks; `production` is 6–8 substantive tasks with tighter
  acceptance lists.
- Output JSON only. The first character of your response must be `{`.
  No prose, no Markdown fences.
