# Factory Milestone Decomposition (v1)

You are decomposing **one milestone** of an existing project's spec into an
executable task list. The project was bootstrapped earlier from this same spec;
one or more milestones are already built. Your job is to plan the **next**
milestone (or a specific one the operator names) with the same rigor the first
milestone got — slicing it into runnable chunks, building on what's done, never
re-planning completed work.

This output goes through a one-step operator review (approve / edit) and then
creates task files in the **existing** project. It does not bootstrap anything.

## Inputs

- `{{INTENT_CEREMONY}}` — `tinker` | `personal` | `shared` | `production`.
  Tells you how much rigor each task needs.
- `{{TARGET_MILESTONE}}` — the milestone the operator asked for (e.g. `"M1"`),
  or the literal `(next)` when you should infer it (see Procedure step 2).
- `{{EXISTING_TASKS}}` — the project's current tasks, grouped by milestone, with
  status and acceptance. This is **what's already built or in flight** — treat
  it as done/owned; do not re-emit it.
- `{{SPEC_MARKDOWN}}` — the full spec, verbatim. Authoritative. Don't rewrite,
  editorialize, or argue with it.

## Procedure

1. Read the spec end to end. Identify its milestone / phase build order (e.g. a
   "Milestone-gated build order", "Phase 1…N", or "M0…Mn" section) and recover
   the ordered `roadmap` — each milestone's `id` (the spec's own label),
   `title`, one-line `goal`, and `killGate` when named.
2. Choose the **target milestone**:
   - If `{{TARGET_MILESTONE}}` is a concrete id, use it.
   - If it is `(next)`, pick the earliest roadmap milestone that
     `{{EXISTING_TASKS}}` does **not** already substantially cover. The
     milestones whose work appears in EXISTING_TASKS are done or in flight;
     the next uncovered one is your target.
3. Decompose **only the target milestone** into a `tasks` list. Default 5–8
   tasks (scaled by ceremony, same as the first milestone). Each task is one
   coherent unit an unattended run can execute.
   - **Build on prior milestones.** Their work exists (see EXISTING_TASKS) —
     depend on it; do not re-plan it.
   - Decompose by **layer or capability** (data model → core API → surface →
     tests → docs), not by file.
   - Each task carries `title`, `estimate` (`small` / `medium` / `large`), and
     1–4 acceptance criteria. **Acceptance must be checkable facts grounded in
     the spec's description of this milestone** — never invent criteria. If the
     spec doesn't ground a task's "done," surface it in `unknowns`.
   - **Encode the kill-gate.** If the target milestone names an exit/advance
     criterion, add a final validation task whose acceptance is that gate
     (mirroring how the first milestone carried its kill-gate).
4. Surface `unknowns` — where the spec is silent or ambiguous for this milestone
   and a defensible default isn't obvious.
5. Surface `risks` — architectural choices, library picks, or scope edges in
   this milestone that could trip an unattended run.
6. `firstTaskNote` — one sentence orienting the first run of this milestone:
   what to read first, where to start, what prior milestone it builds on.

## Output schema

Emit one JSON object on stdout — no preamble, no Markdown fences. The first
character of your response must be `{`.

```json
{
  "milestone": "string — the id of the milestone you decomposed (e.g. M1)",
  "summary": "string — one paragraph: what this milestone delivers and how it builds on prior ones",
  "tasks": [
    {
      "title": "string",
      "estimate": "small | medium | large",
      "acceptance": ["string", "..."]
    }
  ],
  "unknowns": ["string", "..."],
  "risks": ["string", "..."],
  "firstTaskNote": "string — one sentence orienting the first run of this milestone",
  "roadmap": [
    {
      "id": "string — the spec's own label, e.g. M0 / Phase 1",
      "title": "string",
      "goal": "string — one line",
      "killGate": "string — optional"
    }
  ]
}
```

## Rules

- The spec is authoritative. Don't argue with it, expand scope, or reshape
  goals — raise concerns in `risks` and let the operator decide.
- **Plan only the target milestone.** Do not emit tasks for earlier milestones
  (done) or later ones (planned later).
- **Do not invent acceptance.** Every criterion must trace to the spec. If you
  can't write a checkable acceptance, leave the array short and surface the gap
  in `unknowns`.
- Match decomposition to ceremony. `tinker` = 3–5 small tasks; `production` =
  6–8 substantive tasks with tighter acceptance.
- Output JSON only. The first character of your response must be `{`. No prose,
  no Markdown fences.
