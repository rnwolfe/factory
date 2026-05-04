# ADR-002 · Plan primitive — first-class structured collaboration

**Status:** proposed (2026-05-03)
**Scope:** v0.2

## Context

v0.1 ships the spine: idea → triage → bootstrap → run. Bootstrap drops 3–5
task files on disk from `spec_stub.initial_tasks`, and tasks are one-line
titles the agent reads cold at run time. Living with v0.1 surfaced two
related signals:

- **Unattended runs succeed in proportion to planning depth.** When a task
  is well-scoped — acceptance criteria, file-touch list, risks identified —
  the agent stays on rails. When it isn't, the agent drifts: solves the
  wrong problem, rewrites unrelated code, or stops short with
  `factory-status: blocked` because the plan was the gap, not the execution.
  Robust planning is the precondition for genuine "leave it overnight"
  unattended operation.
- **Triage already does the right shape.** Triage is structured agent
  collaboration: typed payload (verdict + axes + spec_stub), comment
  thread, operator pushes back, agent re-evaluates. That same shape applies
  to planning artifacts.

Spec §13's "spec foundry" was slotted v0.4. v0.1 use moves it to v0.2 —
robust planning is what makes unattended runs actually unattended.

## Decision

Introduce a first-class **Plan** primitive: a typed, threaded, freezable
artifact that captures structured agent collaboration around a planning
concern. It is the substrate for project foundry, task expansion, and
(later) refinement and feature planning.

A Plan is the input to a code-changing run, not just a ceremony. Frozen
plans are read into the run prompt as authoritative context.

## Shape

```typescript
type PlanKind =
  | "project_spec"   // post-triage, pre-bootstrap: spec_stub → real spec
  | "task_plan"      // per-task: title → decomposed plan with acceptance + risks
  | "refinement"     // per-task post-run: "do this differently" feedback
  | "feature_plan";  // RESERVED v0.3+: ship-X-into-existing-project (Path B)

type PlanStatus = "drafting" | "frozen" | "abandoned";

interface Plan {
  id: string;
  kind: PlanKind;
  status: PlanStatus;
  // Foreign keys are nullable by kind. project_spec has decisionId before
  // it has projectId (project doesn't exist until freeze).
  decisionId?: string | null;  // project_spec source
  projectId?: string | null;   // task_plan / refinement / feature_plan
  taskId?: string | null;      // task_plan / refinement
  goal: string;                // operator's intent statement, immutable
  draft: PlanDraft;            // structured payload, evolves across thread turns
  createdAt: number;
  updatedAt: number;
  frozenAt?: number | null;
}

interface PlanComment {
  id: string;
  planId: string;
  role: "operator" | "agent";
  body: string;
  // The agent's turns may produce a new draft in the same exchange; we
  // store it on the comment so the diff is auditable.
  resultingDraft?: PlanDraft | null;
  createdAt: number;
}

// Discriminated union — kind-specific shapes.
type PlanDraft =
  | { kind: "project_spec"; summary: string; tasks: TaskSpec[]; unknowns: string[]; risks: string[]; }
  | { kind: "task_plan"; goal: string; steps: PlanStep[]; acceptance: string[]; touches: string[]; risks: string[]; }
  | { kind: "refinement"; targetTaskId: string; feedback: string; revisedAcceptance?: string[]; followups?: TaskSpec[]; };
```

## Lifecycle

```
[drafting] --thread/iterate--> [drafting] ... --freeze--> [frozen] --consumed-->
                                                |
                                                +--> [abandoned] (operator gives up)
```

Drafting plans surface in the inbox the same way pending decisions do —
the operator's only attention sink stays the inbox. Frozen plans are
read-only artifacts attached to their consumer (project, task, run).

## Consumers in v0.2

### 1. Project foundry — between approve and bootstrap

Today: `decisions.action` with `approve` on a triage decision calls
`bootstrapProject` directly, which writes `spec_stub.initial_tasks` to
`.factory/work/`.

v0.2: approve creates a `project_spec` Plan in `drafting` state, seeded
from `spec_stub`. It appears in the inbox. The operator iterates with
the agent (clarify scope, debate decomposition, surface unknowns). On
freeze, `bootstrapProject` runs against the frozen plan instead of the
raw `spec_stub`. The original triage decision is archived as actioned
at approve time; the Plan is its successor.

### 2. Task plan — per-task, before run

Today: a run reads the task body verbatim into the prompt.

v0.2: each task can have an associated `task_plan` Plan. Operator
triggers "expand" from task-detail (or auto-trigger above an estimate
threshold). Plan goes through the thread loop. On freeze, the run
prompt includes the frozen plan as authoritative context — acceptance
criteria, file touches, risks — alongside the task body.

If no `task_plan` exists, runs work as today (cheap tasks don't pay the
planning tax). The operator chooses when to invest.

### 3. Refinement — deferred to v0.2.5 / v0.3

The substrate exists; the implementation is a UI affordance ("re-spec
this task with feedback") that creates a `refinement` Plan whose freeze
action either rewrites the task body or emits follow-up tasks. Ships in
v0.2 if cheap, slips otherwise.

## Integration points

- **`packages/db/src/schema.ts`** — new `plans` and `plan_comments`
  tables. `decisions.kind` does not gain a `plan` variant; plans live
  in their own table because their lifecycle (drafting / frozen /
  abandoned) is distinct from a decision's pending / actioned /
  dismissed.
- **Inbox** — the `decisions.inbox` query is paralleled (or unioned)
  with a `plans.drafting` query. The inbox card kind list grows beyond
  the current `triage | tag_change | blocked_run | merge_failure` to
  include drafting plans.
- **`apps/daemon/src/projects/bootstrap.ts`** — accepts a
  `frozenPlanId` instead of a raw `spec_stub` when called from the
  foundry path. Original call site preserved during migration.
- **`apps/daemon/src/workers/runner.ts`** — `executeRun` reads any
  `frozen` `task_plan` attached to the row's `taskId` and folds it into
  the prompt.
- **Agent invocation for plan iteration** — runs through the same
  `claude --print` path as triage; no `runtime.spawn` (no worktree, no
  commits). Reuse the `agentInvoker` seam in
  `apps/daemon/src/triage/orchestrate.ts`.
- **Plan parser** — same fenced-JSON-block pattern as `factory-status`.
  Null parse → drafting plan stays unchanged with an error comment;
  agent retries. Don't weaken this.

## Path-A / Path-B duality

The Plan primitive is deliberately not coupled to Path A (net-new
project creation). Path B (continuous execution on long-lived projects
— shipping new features against an existing codebase, vision,
conventions) needs the same primitive applied differently:

- Path A loop: triage → `project_spec` → bootstrap → tasks → optional
  `task_plan` → run.
- Path B loop: existing project → operator says "ship feature X" →
  `feature_plan` → decompose into tasks → optional `task_plan` → run.

`feature_plan` is reserved as a kind; v0.2 does not implement it but
the data model accommodates it without migration. Concretely:

- Plans carry `projectId` independently of `decisionId` — a feature
  plan has no triage decision.
- Bootstrap is one of several "freeze actions"; freeze is plan-kind
  specific. A `feature_plan` freeze emits tasks into an existing
  project, not a new one.
- Plan iteration must work without a project being in `bootstrap`
  state — long-lived projects are post-bootstrap.

The stronger architectural commitment: **plans are not a one-time
bootstrap stage.** They're a recurring capability. Treating them this
way from the start avoids the v0.3 refactor where Path B forces it
anyway.

## What stays out of v0.2

- **Quality signal** (lint/typecheck/test runner) — separate from the
  Plan primitive but complementary; ship in the same v0.2 cycle.
- **`feature_plan` implementation** — reserved kind only.
- **Refinement plans** — substrate exists, UI may slip to v0.2.5.
- **Cross-project plan reuse / templates** — not now.
- **Plan auto-generation without operator gate** — not now. Every plan
  freezes by operator action.
- **Retrofitting triage as a Plan** — triage works; data shapes diverge
  enough that retrofitting risks regressions. Reconsider in v0.3 if
  cross-cutting features (history view, plan timeline) make it pay off.

## Open questions

1. **Plan vs. comment as source of truth for the latest draft.** If the
   agent's resulting draft is stored per-comment, the latest comment's
   `resultingDraft` *is* the current `Plan.draft`. Storing both is for
   query convenience; if redundant, drop the column on `plans` and
   compute from latest comment. Decide after building.
2. **Stale drafts.** A plan in `drafting` longer than N days should
   surface as a pending decision ("freeze or abandon"). Cron-y; can
   land alongside the marinate scheduler in v0.3.
3. **Does "design" deserve its own kind?** Design discussions
   (data-model sketches, API shape, UI flow) currently fold into
   `project_spec` or `task_plan` payloads. If the structured shape
   diverges enough in practice — separate from steps/acceptance — add
   `kind: "design"`. Don't pre-add it.
4. **Plan-aware factory-status.** Today's `factory-status` declares
   `done | blocked | failed`. A run that read a frozen `task_plan`
   could additionally declare which acceptance criteria were met.
   Pulls quality signal closer to plan adherence. Worth prototyping
   alongside the quality-signal work.
5. **Authoring constraint enforcement.** Agents write JSON for plan
   drafts the way they write JSON for triage — same fenced-block
   pattern, same null-parse-fail discipline. Per-kind prompt wrappers
   live alongside `wrapPrompt` in the workers/triage paths. Worth a
   shared helper rather than duplicating per-kind.
