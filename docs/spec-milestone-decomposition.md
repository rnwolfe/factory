# Spec — Spec-sourced milestone decomposition

**Status:** Implementation-ready delta. Implements [ADR-009](./adr/009-milestone-decomposition.md).
**Depends on:** the spec-import pipeline (`apps/daemon/src/projects/import-spec.ts`),
the decompose prompt (`prompts/spec-decompose-v1.md`), the task IO seam
(`apps/daemon/src/projects/tasks.ts` → `createTask`), the GitHub task store
metadata (`apps/daemon/src/projects/github-task-store.ts`), and the import
review UI (`apps/pwa/src/routes/import-spec.tsx` `ReviewStep`).

Conventions reminder: `bun run typecheck` + `bun run check` + `bun run test`
before commit. `createTask` is the single point of truth for task creation —
all task writes route through it. No DB migration is required (task metadata is
on-disk YAML for the file backend and an issue-metadata comment for the
github-issues backend).

This is the "Path-B at the next milestone" delta: it makes "plan the next
milestone" reuse the same decompose-and-review engine the first milestone got,
sourced from the project's committed `SPEC.md`.

---

## Phase 1 — Core flow (delivers the fix end to end)

### 1.1 Milestone identity on tasks

`apps/daemon/src/projects/tasks.ts`:
- `TaskFrontmatter`: add optional `milestone?: string` (e.g. `"M1"`).
- `CreateTaskInput`: add `milestone?: string` and `sourceMilestone?: string`
  (provenance, analogous to `sourcePlanId`). `createTask` writes both into
  frontmatter when present (skip when empty, matching existing fields).

`apps/daemon/src/projects/github-task-store.ts`:
- Add `milestone` (and `sourceMilestone`) to `META_KEYS` so the field
  round-trips through the issue-metadata comment for github-issues-backed
  projects. `issueToTaskFile` already copies known meta keys onto frontmatter —
  extend the same way the existing `sourcePlanId` etc. are handled.

No migration: tasks are not a DB table; the daemon indexes them from
disk/issues per request.

### 1.2 Roadmap capture at import

`SpecDecomposition` (in `import-spec.ts`) gains an optional ordered roadmap:

```ts
interface Milestone {
  id: string;        // "M0", "M1", … — the spec's own label, verbatim
  title: string;     // short name
  goal: string;      // one-line intent
  killGate?: string; // exit/advance criterion when the spec names one
}
// SpecDecomposition gains: milestones?: Milestone[]
```

`prompts/spec-decompose-v1.md` — add one rule:

> If the spec defines an explicit milestone / phase build order (e.g. a
> "Milestone-gated build order", "Phase 1…N", or "M0…Mn" section), extract it
> as an ordered `milestones[]`, and **scope the `tasks[]` you emit to the FIRST
> milestone only** (build it richly; later milestones are planned later). If the
> spec has no milestone structure, return `milestones: []` and decompose the
> whole spec as today.

This is the only change to import behavior: for milestone-structured specs the
first batch is *explicitly* the first milestone and the roadmap is captured; for
flat specs behavior is unchanged (`milestones: []`).

`confirmImportSpec` (`import-spec.ts`), when `milestones` is non-empty:
- Tag the bootstrapped tasks with `milestone = milestones[0].id` (thread
  `milestone` through `bootstrapProject` → `createTask`).
- Append a `## Milestone roadmap` section to the generated `AGENTS.md`: one line
  per milestone (`**M1** — title — goal` + kill-gate when present), with a
  pointer to the spec's roadmap section. This is a **static index** written once
  — live status is derived (see 1.5), so `confirmMilestone` never rewrites it.

`coerceDecomposition` extends to validate/coerce `milestones[]` (id+title+goal
required, killGate optional); unknown/malformed → `milestones: []` (degrade to
flat behavior, never throw).

### 1.3 Milestone-scoped decompose prompt

New `prompts/spec-decompose-milestone-v1.md`, derived from `spec-decompose-v1`:
- **Inputs:** the full `SPEC.md` verbatim; the target milestone (id + definition
  + kill-gate); the ordered roadmap; and the **already-completed tasks grouped
  by milestone** (titles + acceptance) so the agent knows what's built.
- **Instructions:** produce tasks **only** for milestone `<M>`. Prior milestones
  are complete — do not re-plan them; build on them. Trace every acceptance
  criterion to the spec; where the milestone names a kill-gate, encode it as
  acceptance on a final validation task (mirror how M0 carried a kill-gate
  task). Surface spec-silent gaps as `unknowns`. Default task count by ceremony,
  same scale as v1. Emit a `firstTaskNote` orienting the first run of this
  milestone.
- **Output:** the same `SpecDecomposition` JSON (tasks / acceptance / unknowns /
  risks / firstTaskNote); `milestones` is omitted (not needed here).

### 1.4 Daemon procedures (mirror propose/confirm import)

`apps/daemon/src/routers/projects.ts`:

**`projects.proposeMilestone({ projectId, milestone?: string })`** — pure
compute, no DB writes (mirrors `proposeImportSpec`):
1. Load project; read `docs/internal/SPEC.md` from the workdir. Absent →
   `PRECONDITION_FAILED`: "this project has no imported spec — use Ship a
   Feature for ad-hoc work."
2. Resolve the roadmap: prefer the `## Milestone roadmap` section of `AGENTS.md`;
   fall back to letting the agent extract it from `SPEC.md`.
3. Resolve the **target milestone**: if `input.milestone` is given, use it; else
   infer "next" = the first roadmap milestone with **zero tasks tagged to it**,
   or the milestone after the highest one whose tagged tasks are all closed
   (`done`/`dropped`). Compute from `listTasks(project)` + the `milestone` field.
4. Build the completed-task context: `listTasks(project)`, group by `milestone`,
   include closed tasks' titles + acceptance for the prompt.
5. Render `spec-decompose-milestone-v1`, `invokeClaudeJson`,
   `coerceDecomposition`. Record metrics under the existing import owner kind.
6. Return `{ milestone, roadmap, decomposition }`.

**`projects.confirmMilestone({ projectId, milestone, decomposition })`**:
1. Validate `decomposition.tasks` with the same Zod shape + cap as
   `confirmImportSpec`.
2. For each task: `createTask(project, { ...task, milestone,
   sourceMilestone: milestone, labels: ["milestone-task"] })` — single point of
   truth; works for file and github-issues backends.
3. `commitAllChanges(project.workdirPath, "chore: plan <milestone> tasks from
   spec", config.gitAuthor)`.
4. Return the created task ids. Auto-advance picks up the first ready task.

`confirmMilestone` does **not** edit `AGENTS.md` — the roadmap index is static;
status is derived.

### 1.5 PWA — "Plan next milestone"

`apps/pwa/src/routes/project-detail.tsx`: for projects that have a
`docs/internal/SPEC.md`, surface a **"Plan next milestone"** action next to the
existing `FeaturePlanLaunch`. Disambiguate copy:
- "Plan next milestone (from spec)" — walks the spec roadmap.
- "Ship a feature" (existing `feature_plan`) — ad-hoc work not in the spec.

The action opens a decompose → review → confirm flow that **reuses the import
`ReviewStep`** (extract it from `import-spec.tsx` into a shared component, or
parameterize in place):
1. `proposeMilestone({ projectId })` (optionally with an operator-picked
   milestone) → loading state during the agent pass.
2. `ReviewStep` in "milestone mode": header shows `Milestone M1 — <title>`, plus
   a read-only roadmap strip and a one-line "built so far: M0 (8 tasks)"
   summary. Operator edits tasks / acceptance / unknowns / firstTaskNote, can
   add/remove tasks.
3. `confirmMilestone({ projectId, milestone, decomposition })` → tasks land →
   navigate back to the project.

A "How is the project doing?" surface for SPEC.md detection: the project query
already returns `workdir`; gate the action on the presence of
`docs/internal/SPEC.md` (cheap existence check added to the project/workdir
payload).

---

## Phase 2 — Polish (independently shippable, not required for the fix)

- **Milestone tracker** on the project header: a compact strip rendering the
  `AGENTS.md` roadmap with **derived** status per milestone — `done` (all its
  tagged tasks closed), `active` (has open tagged tasks), `next`/`planned` (no
  tasks yet). Pure read over `listTasks` + the roadmap index.
- **Provenance rendering:** `taskSourceLinks` shows a "milestone M1" chip from
  `sourceMilestone`, consistent with plan/audit provenance.
- **Explicit milestone picker** in the propose flow (drop-down over the roadmap)
  for replanning or skipping ahead, instead of always inferring "next."

---

## Reuse summary (what we are NOT rebuilding)

- `SpecDecomposition` / `coerceDecomposition` — extended (add `milestones`),
  not replaced.
- `ReviewStep` — shared between import and milestone modes.
- `createTask` — the single point of truth; gains `milestone` /
  `sourceMilestone`, works across both backends unchanged.
- The decompose-prompt discipline (typed fenced-JSON, null-parse-fail,
  acceptance-traces-to-spec) — a new milestone-scoped sibling prompt, same shape.

## Non-goals

- No DB roadmap entity or milestone lifecycle state machine (ADR-009 Option C,
  deferred).
- No change to `feature_plan` or the vision filter.
- No automatic retro-tagging of existing projects' tasks. `proposeMilestone`
  infers "next" from whatever `milestone` tags exist and defaults to operator
  selection when ambiguous, so a project bootstrapped before this change still
  works (the operator names the milestone the first time).

## Validation

- **Unit:** `coerceDecomposition` parses/degrades `milestones[]`;
  `proposeMilestone` infers the next milestone from tagged task state;
  `confirmMilestone` tags `milestone` + `sourceMilestone` via `createTask` for
  **both** backends (seam test, github via injected `FetchFn`).
- **Prompt:** `spec-decompose-milestone-v1` renders with spec + roadmap +
  completed-task context.
- **Proving ground — `lodestar`:** `proposeMilestone(M1)` reads `SPEC.md` §13 +
  the M0 task set and drafts M1 tasks traced to the spec, replacing the
  `task-009` / `task-010` stubs. (Run only when the operator opts in — prod is
  read-mostly; this is the real-world acceptance test for the design.)

## Edge cases

- **Flat spec (no milestone section):** import returns `milestones: []`
  (unchanged); `proposeMilestone` reports "no milestone roadmap in this spec —
  use Ship a Feature," or requires the operator to name a scope. The milestone
  flow requires a milestone-structured spec.
- **github-issues backend:** `milestone` rides in issue metadata; completed-task
  context comes from `listTasks` over issues; no file-path assumptions.
- **Ambiguous "next":** when tagged task state doesn't yield a clean next
  milestone, the propose flow asks the operator to pick from the roadmap.
