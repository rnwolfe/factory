# ADR-009 — Spec-sourced milestone decomposition for incremental build-out

**Status:** Proposed (design; implementation pending — see `docs/spec-milestone-decomposition.md`)
**Date:** 2026-06-21
**Deciders:** Ryan Wolfe

---

## Context

Factory has two ways work enters a project, and only one of them is rich.

**Spec-import (rich).** `apps/daemon/src/projects/import-spec.ts` takes an
operator's full spec markdown, runs it through the `spec-decompose-v1` prompt
(decompose-by-layer, *acceptance-must-trace-to-spec*, a `firstTaskNote`
orientation), presents an **operator review/edit gate** (`ReviewStep` in
`apps/pwa/src/routes/import-spec.tsx`), then bootstraps the project and writes
the spec verbatim to `docs/internal/SPEC.md`. `AGENTS.md` points the agent at
that file as the source of truth. This is why the *first* milestone lands well.

**Incremental (thin).** The only primitive for "build the next thing" is
`feature_plan` (`plans.startFeaturePlan` → `seedFeaturePlanDraft`). It is seeded
by a **≤280-char goal textarea** and nothing else. Its iterate prompt
(`apps/daemon/src/plans/iterate.ts`, `feature_plan` branch) reads
`README.md` / `AGENTS.md` / `VISION.md` — but **not `docs/internal/SPEC.md`,
not the existing task list, not run history**. It emits ≤5 tasks from a thinner
prompt with no review gate.

The problem surfaces when an imported spec is **robust** — i.e. a
milestone-structured roadmap. The importer correctly drafts only the *first*
milestone's tasks, but captures milestones 2..N **nowhere structured**: they
survive only as prose inside `SPEC.md`. Tasks carry no milestone identity, and
spec-import skips the `project_vision` auto-trigger, so there is often no
`VISION.md` either. When the operator finishes milestone 1 and asks Factory to
"plan the next milestone," they fall off the rich path onto `feature_plan`,
which cannot even *see* the spec that defines that milestone. The result is
underspecified.

**Grounding example — `lodestar` (prod).** `docs/internal/SPEC.md` (488 lines)
has an explicit §13 "Milestone-gated build order": M0–M5, each with a kill-gate.
Import drafted M0 cleanly → `task-001…008`, traced to spec §15/§16/§17. To
advance, the operator was forced to hand-roll stub tasks: `task-009 "Execute
M1"` (body: *"Create the plan for the M1 section of the spec."*) and
`task-010 "Review M1 in spec and create a plan…"` (acceptance: *"(TBD)"*).
Those stubs are the operator doing, by hand and in tasks, the
milestone-decomposition step the product should own. There is no `VISION.md`.

Building a NEW project from a robust spec is inherently milestone-by-milestone.
Factory models "bootstrap once → then ad-hoc features," not "walk a spec's
roadmap, decomposing each milestone with the same rigor as the first."

## Decision

1. **Treat `docs/internal/SPEC.md` as a durable, milestone-structured roadmap** —
   the single source of truth for what to build next, walked one milestone at a
   time. The spec is already repo-canonical and preserved verbatim; we stop
   discarding its roadmap after the first milestone.

2. **"Plan the next milestone" reuses the import decompose engine,
   milestone-scoped, against the existing project.** A new milestone-scoped
   prompt (`spec-decompose-milestone-v1`) sourced from the project's committed
   `SPEC.md`, the same `SpecDecomposition` type, and the same operator
   `ReviewStep`. It emits tasks via the single-point-of-truth `createTask`
   into the existing project (not `bootstrapProject`). The prompt is told: prior
   milestones are **done** (here are their tasks) — build on them, plan only
   milestone M, trace acceptance to the spec, and encode the milestone's
   kill-gate as acceptance on a final validation task (mirroring how M0 carried
   one).

3. **Persist milestone identity lightly; derive progression.**
   - `TaskFrontmatter` gains an optional `milestone?: string` (e.g. `"M1"`).
     Import tags the first batch; milestone decomposition tags its batch. For
     the github-issues backend it rides in the issue metadata comment.
   - At import, the spec's ordered roadmap is captured into a
     `## Milestone roadmap` section of `AGENTS.md` — repo-canonical, the agent's
     reading list, referencing the spec's roadmap section.
   - Which milestone is done / active / next is **derived** from tasks'
     `milestone` field + their statuses. **No new DB entity, no separate
     roadmap lifecycle.**

4. **`feature_plan` stays for genuine ad-hoc features not in the spec**
   ("add export-to-markdown"). Milestone decomposition is for walking a spec's
   roadmap. The two intents stay distinct and are not merged. The `feature_plan`
   vision filter does **not** apply to milestone decomposition — the spec is the
   authority and the milestone is the scope gate.

## Alternatives considered

- **Make `feature_plan` spec- and history-aware** (read `SPEC.md` + task list,
  pick "from milestone N"). Rejected as the primary: `feature_plan` stays a thin
  ≤5-task ad-hoc primitive, it muddies the feature-vs-milestone distinction, and
  it lacks the structured review gate the operator remembers from import.

- **A first-class milestone/roadmap DB model + lifecycle state machine**
  (parse the roadmap into rows, track active/done, drive an explicit
  advance→decompose→gate loop). Best long-term UX, but a real schema + state
  machine for a single-operator tool. Premature: we derive progression from
  existing task state instead, and revisit only if derivation proves
  insufficient. (This is the deliberately-deferred "Option C.")

- **Model the next milestone as a new plan kind** (inbox-threaded iterate loop
  like `project_spec`). Rejected: the "same flow" the operator wants is the
  import *wizard* (propose → review → confirm), not the conversational plan
  loop. Mirroring import is more faithful and less new surface than a plan kind
  with its own prompt + apply path.

## Consequences

- **+** The next milestone gets the same decomposition rigor and operator review
  as the first.
- **+** `SPEC.md` stays the single source of truth; no roadmap drift.
- **+** Minimal schema impact — one optional task-frontmatter field; **no
  migration** (task metadata is on-disk YAML / issue metadata, not a DB table).
- **+** The operator gets a milestone tracker derived from task state, for free.
- **−** Milestone detection relies on the spec having a recognizable roadmap
  section; the prompt uses a heuristic and falls back to the operator naming the
  target milestone.
- **−** Triage-origin projects (no `SPEC.md`) don't get this; they keep
  `feature_plan` / the `project_vision` roadmap as today.
- **−** Derived progression can be ambiguous if tasks are added outside the
  milestone flow; the operator can always pick the target milestone explicitly.

## Amendment (2026-07-02) — the hands-off-preset auto-confirm exception

Decision §2 makes the operator `ReviewStep` the confirm gate: a milestone
decomposition is proposed, the operator reviews/edits it, and only then does it
materialize into tasks. That manual gate is still the default and still applies
to every preset **except one**.

**The exception.** For a project whose autonomy configuration resolves to the
`hands-off` preset (i.e. `matchingAutonomyPreset(db, projectId) === 'hands-off'`,
`AutonomyPreset` in `apps/daemon/src/autonomy/config.ts`), the post-merge
queue-drain path auto-plans **and auto-confirms** the next milestone with no
`ReviewStep` interaction: `autoPlanNextMilestone` (`apps/daemon/src/projects/auto-milestone.ts`)
runs the same `spec-decompose-milestone-v1` decompose engine, then calls
`confirmMilestone` directly. This is the deliberate point of the `hands-off`
preset — the operator has opted the project into unattended planning *and*
execution, so pausing on a human review gate would defeat the preset. Every
other preset (`conservative`, `balanced`) keeps the manual queue-empty nudge and
the `ReviewStep` gate exactly as Decision §2 specifies.

**The mitigation — the contained-blast-radius guardrail.** Skipping human review
is only safe because the auto-confirm is *gated on plan-time blast radius*, not
unconditional. Before it confirms, `autoPlanNextMilestone` classifies the
proposed decomposition with `classifyMilestoneBlastRadius`
(`apps/daemon/src/workers/verifier.ts`) — the plan-time analogue of the
diff-time `classifyBlastRadius`: task count ↔ file count (`MILESTONE_TASK_LIMIT`),
a `large` estimate ↔ high churn, and a risk-sensitive topic
(auth / secrets / migration / infra / CI / payment) ↔ a risk-sensitive path. It
then applies the **same ceiling** hands-off already enforces on autorun
(`autorun.maxBlastRadius`, `"contained"`) via the shared `isWithinBlastCeiling`
predicate. A `contained` decomposition is auto-confirmed; a `broad` one
(large-estimate task, risk-sensitive topic, or too many tasks) returns
`created: 0` / `outcome: "blast_exceeded"` and falls back to the manual
queue-empty nudge — i.e. it degrades to exactly the pre-existing
manual-confirm behavior and leaves the next milestone for the operator to
review. Unattended planning is thus capped at the same contained blast radius as
unattended execution: broad work always still passes through a human.

**Scope — this is not a general precedent.** This exception is scoped to
`autonomyPreset === 'hands-off'` and to milestone decomposition specifically. It
does **not** license skipping operator review anywhere else: the spec-import
`ReviewStep`, `feature_plan` iteration, audit-report promotion, and every other
confirm gate remain manual regardless of preset. The `hands-off` preset is an
explicit operator opt-in with a bounded blast-radius guarantee, not a signal
that review gates are optional in general. If a future change wants to auto-skip
a different review gate, it needs its own ADR and its own guardrail — do not cite
this amendment as cover.
