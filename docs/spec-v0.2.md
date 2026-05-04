# Factory v0.2 — Specification

> **Scope:** v0.2 only — the changes layered on top of v0.1.
> **Companion docs:** `docs/spec.md` (v0.1, frozen), `docs/vision.md` (post-v0.1
> direction), `docs/adr/002-plan-primitive.md` (architectural commit this spec
> implements), `CLAUDE.md` (architectural contracts).
>
> Read `docs/spec.md` once first if you have not. This document does not repeat
> v0.1's data model, runtime, or PWA conventions; it specifies only the deltas.

-----

## 1. Theme & one-paragraph thesis

v0.1 proves the spine: idea → triage → bootstrap → run → tag. v0.2 is the
**planning unlock**: introduce a first-class **Plan** primitive — typed,
threaded, freezable artifacts — and use it to put structured agent
collaboration in front of the two places agents currently fly blind:
post-triage project specs and pre-run task plans. The same primitive carries
post-run refinement (deferred), and is reserved (not implemented) for the
Path-B feature-plan kind. Alongside the Plan work, v0.2 lands a **quality
signal** subsystem: lint/typecheck/test runners that execute opportunistically
after a code-changing run and surface results in the run summary. Together
these turn unattended runs from "the agent hopes it understood" into "the
agent works against a frozen plan and we know whether the result holds."

-----

## 2. Goals & Non-Goals

### 2.1 Goals (v0.2)

- A `project_spec` Plan is created when the operator approves a triage
  decision. The Plan iterates with the operator+agent in the inbox until
  frozen. Bootstrap reads the frozen Plan, not the raw `spec_stub`.
- A `task_plan` Plan can be optionally created against any task. When
  frozen, runs against that task fold the Plan's draft into the prompt
  as authoritative context.
- Plan iteration uses the same comment-thread shape as triage: operator
  posts, agent re-drafts, repeat until freeze.
- Drafting plans surface in the existing inbox; the operator's only
  attention sink remains the inbox.
- Code-changing runs execute a per-project quality check pass after the
  agent declares `done`. Results land in the run summary panel.
- Existing v0.1 flows continue to work — projects and tasks created in
  v0.1 don't require migration; runs without an attached task_plan
  behave as in v0.1.

### 2.2 Non-Goals (v0.2)

- `feature_plan` Plan kind. The data model accommodates it (ADR-002 §
  Path-A/Path-B duality); v0.2 does not implement Path-B flows.
- `refinement` Plan kind UI. The schema, route surface, and prompt
  template are scaffolded; the dedicated UI affordance ("refine this
  task") may slip to v0.2.5 / v0.3. If included in v0.2, it is the
  last item shipped, after foundry, task-plan, and quality signal.
- Quality signal as a merge gate. v0.2 quality is informational only.
  Gating is v0.3 verification.
- Per-project rubrics for quality (alignment-with-vision rubric). v0.3+.
- Retrofitting triage as a Plan. Triage stays as-is in v0.2.
- Push notifications, marinate scheduler, in-app rubric editor,
  multi-iteration `createSession`, multi-provider — all v0.3+.
- Plan auto-generation without operator gate. Every plan freezes by
  explicit operator action.

-----

## 3. Architecture deltas

v0.1 architecture stands. v0.2 adds:

- **Plan iteration agent path.** A new code path mirroring
  `apps/daemon/src/triage/orchestrate.ts` — pipes a structured prompt
  to `claude --print`, parses a fenced JSON response, persists a new
  `PlanComment` with the agent's reply and `resultingDraft`. No
  worktree, no tmux. Reuses the `agentInvoker` injection seam for tests.
- **Quality runner module.** `apps/daemon/src/workers/quality.ts`
  executes a list of shell commands inside the run's worktree after
  agent completion and before merge. Results are persisted on the run
  row and broadcast over `/ws/events`. Module is sandbox-aware: same
  `--dangerously-skip-permissions` posture is N/A here (these aren't
  agent invocations); commands run as the daemon user with stdout/stderr
  captured.
- **Inbox merging happens in the PWA, not the daemon.** The daemon
  exposes `decisions.inbox` (existing) and `plans.inbox` (new) as
  parallel queries; the PWA inbox route fetches both and interleaves
  by `createdAt`. Keeps tRPC procedures cohesive and avoids a
  cross-table union query.

-----

## 4. Data Model deltas

### 4.1 New tables

`plans`:

| column         | type                  | notes |
|----------------|-----------------------|-------|
| `id`           | text PK               | cuid2 |
| `kind`         | text NOT NULL         | enum (TS-only): `project_spec` \| `task_plan` \| `refinement` \| `feature_plan` (reserved) |
| `status`       | text NOT NULL DEFAULT `'drafting'` | enum: `drafting` \| `frozen` \| `abandoned` |
| `decision_id`  | text NULL → `decisions(id)` | set when `kind='project_spec'`; null for task_plan/refinement |
| `project_id`   | text NULL → `projects(id)`  | null until project exists (project_spec pre-freeze) |
| `task_id`      | text NULL             | task IDs are file-frontmatter strings, not FK; null for project_spec |
| `goal`         | text NOT NULL         | operator's intent statement, immutable after creation |
| `draft`        | text NOT NULL (JSON)  | current draft payload (PlanDraft union) |
| `created_at`   | integer NOT NULL      | epoch ms |
| `updated_at`   | integer NOT NULL      | epoch ms; bumped on draft change or comment |
| `frozen_at`    | integer NULL          | set when status moves to `frozen` |
| `abandoned_at` | integer NULL          | set when status moves to `abandoned` |

`plan_comments`:

| column            | type                   | notes |
|-------------------|------------------------|-------|
| `id`              | text PK                | cuid2 |
| `plan_id`         | text NOT NULL → `plans(id)` | |
| `role`            | text NOT NULL          | enum: `operator` \| `agent` |
| `body`            | text NOT NULL          | free-text comment (operator) or summary/reply text (agent) |
| `resulting_draft` | text NULL (JSON)       | when agent's turn produced a new draft, stored here for diff/audit |
| `created_at`      | integer NOT NULL       | |

Indexes:
- `plans (status, created_at desc)` for inbox queries
- `plans (project_id, kind)` for project-scoped lookups
- `plan_comments (plan_id, created_at)` for thread display

### 4.2 Modified tables

`runs`:
- Add `task_plan_id` text NULL — references `plans(id)` of the frozen
  task_plan whose draft was folded into this run's prompt. Null for
  runs without an attached plan (v0.1 behavior preserved).
- Add `quality_report` text NULL (JSON) — captured QualityReport (§9).

`decisions`:
- No schema changes. The `triage` decision lifecycle is unchanged; what
  changes is the side-effect of `decisions.action` with `action='approve'`
  on a triage decision (see §6).

### 4.3 TypeScript shapes

Defined in `packages/db/src/schema.ts` alongside existing tables. Reuse
the v0.1 `text("kind", { enum: ... })` Drizzle pattern (TS-only enum,
no SQL CHECK constraint — kind values are stored as plain text).

```ts
export const planKindEnum = [
  "project_spec", "task_plan", "refinement", "feature_plan",
] as const;
export const planStatusEnum = ["drafting", "frozen", "abandoned"] as const;
export const planCommentRoleEnum = ["operator", "agent"] as const;

export type PlanKind = (typeof planKindEnum)[number];
export type PlanStatus = (typeof planStatusEnum)[number];

// PlanDraft as discriminated union — kind-specific shapes.
export interface ProjectSpecDraft {
  kind: "project_spec";
  summary: string;
  tasks: Array<{
    title: string;
    estimate: "small" | "medium" | "large";
    acceptance: string[];
  }>;
  unknowns: string[];
  risks: string[];
}

export interface TaskPlanDraft {
  kind: "task_plan";
  goal: string;
  steps: Array<{ order: number; title: string; detail: string }>;
  acceptance: string[];
  touches: string[];           // file path globs the agent expects to modify
  risks: string[];
}

export interface RefinementDraft {
  kind: "refinement";
  targetTaskId: string;
  feedback: string;
  revisedAcceptance?: string[];
  followups?: Array<{ title: string; estimate: "small" | "medium" | "large" }>;
}

export type PlanDraft = ProjectSpecDraft | TaskPlanDraft | RefinementDraft;
```

Lifecycle invariants enforced in router code (not at the DB):
- `frozen_at` and `abandoned_at` are mutually exclusive and only one
  may be non-null. `status` and these timestamps move together in a
  single update.
- `goal` is set on insert and never updated.
- `draft` is updated on every agent turn that returns a parseable
  payload; the new value is also written to the resulting comment's
  `resulting_draft`.
- Once `status != 'drafting'`, comments and draft updates are rejected.

### 4.4 Migration

Single Drizzle migration (`0005_plan_primitive.sql`):
```sql
CREATE TABLE plans (...);
CREATE TABLE plan_comments (...);
CREATE INDEX ...;
ALTER TABLE runs ADD COLUMN task_plan_id text;
ALTER TABLE runs ADD COLUMN quality_report text;
```

No data backfill needed. Existing v0.1 runs have `task_plan_id IS NULL`
and `quality_report IS NULL`; the runner treats null as "v0.1 behavior."

-----

## 5. API — tRPC routes

All under `protectedProcedure`. Same bearer auth as v0.1.

### 5.1 New router: `plansRouter` (mounted as `plans`)

```
plans.inbox()
  → returns Plan[] where status='drafting', ordered by createdAt desc.
    PWA inbox merges with decisions.inbox.

plans.list({ projectId?: string })
  → returns Plan[] for the given project (or all). Used by project
    detail page to show plan history.

plans.get({ id })
  → returns Plan | null.

plans.comments({ planId })
  → returns PlanComment[] in createdAt asc order.

plans.startProjectFoundry({ decisionId })
  → mutation. Reads the triage decision payload, creates a Plan with
    kind='project_spec' seeded from the decision's spec_stub, status
    'drafting'. Triggers agent's first iteration immediately (the
    "seeded" draft is the agent's spec_stub from triage; the first
    operator action is to comment or freeze).
    Returns { planId }.

plans.startTaskPlan({ projectId, taskId })
  → mutation. Creates a Plan with kind='task_plan' targeting the task.
    The initial draft is empty (agent's first turn fills it on the
    operator's first comment "expand this task"). Returns { planId }.

plans.startRefinement({ projectId, taskId, runId })
  → mutation. Creates a Plan with kind='refinement', seeded with the
    target task and source run. Returns { planId }.

plans.comment({ planId, body })
  → mutation. Inserts an operator comment. Schedules a background
    agent turn (same fire-and-forget pattern as decisions.comment).
    Returns { commentId }. Agent reply lands as a separate comment
    asynchronously and broadcasts decision_updated-style events on
    /ws/inbox (see §10).

plans.freeze({ planId })
  → mutation. Marks status='frozen', sets frozen_at. Triggers the
    kind-specific consumer:
      - project_spec: calls bootstrapProject with the frozen draft
        (replacing decision.payload.spec_stub).
      - task_plan: no immediate side-effect; the next run.submit on
        this task will pick up the plan.
      - refinement: rewrites the target task body with revisedAcceptance
        merged in, and emits any followups as new task files. Commits
        on main (operator-driven mutation, same as tasks.updateBody).
    Returns { ok: true, projectId?: string, taskId?: string }.

plans.abandon({ planId })
  → mutation. Marks status='abandoned', sets abandoned_at. No
    side-effects beyond the inbox removal.
```

### 5.2 Modified routes

`decisions.action`:
- When `action='approve'` and `decision.kind='triage'`: instead of
  immediately calling `bootstrapProject`, call
  `plans.startProjectFoundry({ decisionId })` internally and return
  `{ ok: true, projectId: null, planId, retryRunId: null, mergedSha: null }`.
  The decision row is marked `actioned` immediately (the approval
  happened); the project doesn't exist yet — it materializes on plan
  freeze.
- All other action paths (`blocked_run` retry, `merge_failure` retry,
  `tag_change`, `dismiss`, `park`, `decompose`, `trash`) unchanged.

`runs.submit` (or wherever submit happens — currently
`apps/daemon/src/workers/submit.ts`):
- When `taskId` is provided and a frozen `task_plan` exists for that
  taskId in the same project, set `task_plan_id` on the run row.
- The runner reads `task_plan_id` and folds the plan draft into the
  prompt (§7).

### 5.3 WS events on `/ws/inbox`

New event kinds:
- `plan_created` — `{ planId, kind, projectId? }` — broadcast on
  startProjectFoundry / startTaskPlan / startRefinement.
- `plan_updated` — `{ planId }` — broadcast when the agent produces a
  new draft.
- `plan_comment_added` — `{ planId, role }` — broadcast on operator or
  agent comment.
- `plan_frozen` — `{ planId, projectId?, taskId? }` — broadcast on
  freeze.
- `plan_abandoned` — `{ planId }`.

The `/ws/events` and `/ws/pane` channels are unchanged.

-----

## 6. Runtime deltas

`packages/runtime` v0.2 changes are minimal — plan-aware prompting
happens in the daemon worker layer, not in `runtime.spawn`.

### 6.1 Plan-aware run prompt

`apps/daemon/src/workers/runner.ts` — when the run row has a non-null
`task_plan_id`:

1. Load the Plan and verify `status='frozen'` (defensive — should be
   enforced at submit time).
2. Render the plan's `draft` into a structured prompt block — fenced,
   labeled, and explicitly authoritative.
3. Wrap the existing task body and the plan block via a new
   `wrapPromptWithPlan(taskBody, frozenDraft)` helper alongside
   `wrapPrompt` in `factory-status.ts`.
4. Append the existing `factory-status` footer.

Suggested prompt structure (illustrative, tune during build):
```
You are working on task ${taskId}.

## Task body
${taskBody}

## Frozen plan (authoritative)
This plan was iterated on with the operator and frozen. Do not
deviate from its scope. If a step is impossible, declare blocked
in the factory-status block.

Goal: ${plan.goal}

Steps:
1. ${steps[0].title} — ${steps[0].detail}
...

Acceptance criteria:
- ${acceptance[0]}
...

Files expected to be touched:
- ${touches[0]}
...

Risks called out:
- ${risks[0]}
...

## Factory status footer
${existing factory-status footer}
```

### 6.2 Optional: plan-aware factory-status

When the run has an attached plan, the `factory-status` block schema is
extended:
```json
{
  "status": "done" | "blocked" | "failed",
  "summary": "...",
  "questions": ["..."],
  "acceptance": [
    { "criterion": "...", "met": true, "evidence": "commit abc123" },
    { "criterion": "...", "met": false, "reason": "..." }
  ]
}
```

`acceptance` is optional — null parse of acceptance does not fail the
parse; the run completes as today. When present, results are surfaced
in the run summary panel alongside the quality signal.

Parser changes live in
`apps/daemon/src/workers/factory-status.ts` — add an optional
`acceptance` field to the parsed shape.

-----

## 7. Plan iteration — agent prompts

Each Plan kind has its own prompt template, mirroring the triage
prompt's shape. All prompts:

- Are stored in `prompts/` alongside the existing triage prompt files.
- Are versioned via the existing `prompts` table (introduced in v0.1
  for triage). Each Plan kind has a `prompt_key` (e.g.
  `plan_project_spec_v1`).
- Require the agent to emit a fenced JSON block matching the Plan
  kind's draft shape, plus a `reply` field for the comment body.
- Use the same null-parse-fail discipline as `factory-status`: if
  the JSON is missing or unparseable, the agent's text becomes a
  comment but the draft is unchanged. The operator can re-comment
  to nudge the agent.

### 7.1 `project_spec` prompt (sketch)

Inputs:
- The originating idea text.
- The triage decision's `spec_stub` (as the seed draft).
- The thread of operator+agent comments to date.

Output JSON schema:
```json
{
  "summary": "string — one paragraph project summary",
  "tasks": [
    {
      "title": "string",
      "estimate": "small" | "medium" | "large",
      "acceptance": ["string", ...]
    }
  ],
  "unknowns": ["string", ...],
  "risks": ["string", ...],
  "reply": "string — what the agent wants to say back to the operator"
}
```

The agent is instructed to:
- Treat operator pushback as authoritative.
- Surface unknowns explicitly rather than guessing.
- Flag risks (compatibility, scope creep, hidden complexity).
- Keep the task list small and concrete (default ≤ 5 tasks; only add
  more when the operator explicitly asks for decomposition).

### 7.2 `task_plan` prompt (sketch)

Inputs:
- The project's `CLAUDE.md` (if present) and `README.md` for context.
- The task's body (frontmatter + markdown).
- The thread to date.

Output JSON schema:
```json
{
  "goal": "string — restated task goal in agent's words",
  "steps": [
    { "order": 1, "title": "string", "detail": "string" }
  ],
  "acceptance": ["string", ...],
  "touches": ["src/foo/bar.ts", "apps/pwa/...", ...],
  "risks": ["string", ...],
  "reply": "string"
}
```

`touches` is glob-friendly path strings; the agent is encouraged to be
specific (full paths > globs > directory hints).

### 7.3 `refinement` prompt (sketch)

Inputs:
- The target task body.
- The source run's summary + diff (or commit list).
- The operator's feedback.
- The thread to date.

Output JSON schema:
```json
{
  "feedback": "string — agent's restatement of the issue",
  "revisedAcceptance": ["string", ...],
  "followups": [
    { "title": "string", "estimate": "small" | "medium" | "large" }
  ],
  "reply": "string"
}
```

`revisedAcceptance` and `followups` are both optional — the agent may
propose only one, both, or neither (in which case `reply` is the
operator's full answer and freeze is a no-op).

### 7.4 Shared invocation path

A single helper in `apps/daemon/src/plans/iterate.ts`:

```ts
async function runPlanIteration(deps: PlanDeps, planId: string): Promise<void>;
```

- Loads the plan + thread + kind-specific context.
- Renders the prompt via per-kind template.
- Invokes via the same `agentInvoker` injection seam used by
  `triage/orchestrate.ts`.
- Parses the response (fenced JSON).
- On parse success: insert agent `PlanComment` with `resulting_draft`
  populated, update `plans.draft` and `updated_at`.
- On parse failure: insert agent `PlanComment` with `body` set to the
  agent's raw text and a `(plan iteration failed: malformed JSON)`
  trailer, leave `draft` unchanged.
- Broadcast `plan_comment_added` and (on success) `plan_updated`.

Called from `plans.comment` after the operator's comment is persisted
(fire-and-forget, like triage follow-up).

-----

## 8. PWA — new screens & UX

### 8.1 Inbox (modified)

`apps/pwa/src/routes/inbox.tsx` (or wherever the inbox renders):
- Add a parallel `plans.inbox()` query.
- Merge the two result sets by `createdAt desc`.
- Render plan cards via a new `PlanCard` component (decision cards
  already render via `DecisionCard`).
- WS subscription on `/ws/inbox` already exists; add handlers for the
  new `plan_*` event kinds — invalidate `plans.inbox` query on each.

### 8.2 `PlanCard` component

`apps/pwa/src/components/plan-card.tsx`:
- Same surface treatment as `DecisionCard` (warm-dark, dense rows).
- Header chips: kind label (`project spec` / `task plan` /
  `refinement`), status (`drafting`), kind tone (use `chip-decompose`
  for plans).
- Headline: the Plan's `goal`.
- Body: latest agent comment's `body` (truncated to 2 lines).
- No swipe actions (drafting plans aren't approve/dismiss-able from
  the card — they need iteration). Tap-anywhere opens detail.

### 8.3 Plan detail route

New route `/plans/:id` → `apps/pwa/src/routes/plan-detail.tsx`:

Sections (top to bottom on a 390px viewport):

1. **Header.** Back link to inbox. Chips: kind, status, project link
   (if attached). Goal as the display headline. Created/updated
   timestamps.

2. **Draft viewer.** Kind-specific render:
   - `project_spec`: summary paragraph; numbered task list with
     estimate chips and acceptance bullets; collapsible "unknowns"
     and "risks" sections.
   - `task_plan`: goal restatement; numbered steps with detail
     paragraphs; acceptance bullets; touches list (mono); risks.
   - `refinement`: feedback paragraph; revisedAcceptance bullets (if
     present); followups list (if present).
   Renders from the latest `Plan.draft` (which mirrors the latest
   comment's `resulting_draft`).

3. **Thread.** Same component as triage's thread. Operator + agent
   comments in `createdAt asc` order. Agent comments with
   `resulting_draft` show a small "draft updated" affordance.

4. **Composer.** Textarea + send. Disabled when `status != 'drafting'`.
   Same skeleton-thinking pattern as triage during agent turn.

5. **Footer actions.** When drafting:
   - Primary: `Freeze`. Confirmation modal explains the consumer
     (bootstrap project / attach to run / rewrite task body).
   - Secondary: `Abandon`. Confirmation modal warns the plan can't
     be resumed.
   When frozen / abandoned: status chip and link to consumer; no
   actions.

### 8.4 Task detail (modified)

`apps/pwa/src/routes/task-detail.tsx`:
- Above the body, render a "Plan" section:
  - When no `task_plan` exists for this task: button "Expand task
    with a plan" → calls `plans.startTaskPlan` and navigates to
    `/plans/<newId>`.
  - When a `task_plan` exists in `drafting`: card linking to
    `/plans/:id` with status chip and latest agent reply.
  - When a `task_plan` exists `frozen`: collapsed plan summary
    inline (steps count, acceptance count, touches count) with a
    "View frozen plan" link.
- The existing "Start run" CTA: when a frozen task_plan exists, a
  small mono affordance reads "with frozen plan" so the operator
  knows the prompt will include it.

### 8.5 Project detail (modified)

`apps/pwa/src/routes/project-detail.tsx`:
- New section: "Plans" — collapsed by default, lists drafting plans
  for this project (non-zero count badge in section header).
- The triage approve flow now lands on `/plans/:id` (the project
  doesn't exist yet on a project_spec freeze). The existing redirect
  in decision-detail's mutation `onSuccess` is updated to handle
  `planId` in the response.

### 8.6 Decision detail (modified)

`apps/pwa/src/routes/decision-detail.tsx`:
- For triage decisions, the `approve` button copy becomes
  `approve & start foundry` (or just `approve` with secondary text
  "starts a project_spec plan in the inbox"). On success, the
  navigation goes to `/plans/<planId>` instead of `/projects/<id>`.

### 8.7 Run detail / live pane (modified)

`apps/pwa/src/routes/live-pane.tsx`:
- Header line gains a "plan" chip linking to `/plans/<task_plan_id>`
  when the run has one attached.
- Run summary panel renders the QualityReport when present (§9).
- Run summary panel renders plan acceptance results when the agent's
  `factory-status` block included them.

-----

## 9. Quality signal subsystem

### 9.1 Configuration

Per-project config at `<project>/.factory/quality.yaml` (committed to
the project's main, like other `.factory/` files):

```yaml
checks:
  - name: typecheck
    command: bun run typecheck
    cwd: .            # default; override for monorepos
    timeoutSeconds: 300
  - name: lint
    command: bun run check
    timeoutSeconds: 120
  - name: test
    command: bun test
    timeoutSeconds: 600
```

Bootstrap seeds `quality.yaml` based on detection:
- `package.json` with a `typecheck` script → typecheck check.
- `biome.json` or `package.json` with a `check` script → lint check.
- Any `*.test.ts`/`*.test.tsx`/`tests/` → test check.

If the file doesn't exist after bootstrap, no quality checks run for
that project (operator can opt in by creating the file).

### 9.2 Execution

`apps/daemon/src/workers/quality.ts`:

```ts
interface QualityCheck {
  name: string;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
}

interface QualityCheckResult {
  name: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;   // last ~4 KB
  stderrTail: string;   // last ~4 KB
  timedOut: boolean;
}

interface QualityReport {
  ranAt: number;
  results: QualityCheckResult[];
  overall: "pass" | "fail" | "skipped";
}

async function runQualityChecks(opts: {
  worktreePath: string;
  configPath: string;  // <project>/.factory/quality.yaml
}): Promise<QualityReport>;
```

Invoked by `runner.ts` after the agent declares `done`, before
`mergeIntoMain`. Failures do **not** block merge in v0.2 — the report
is informational. Persisted to `runs.quality_report` (JSON). Broadcast
on `/ws/events` as a new `quality_report` event.

### 9.3 Output rendering

PWA `live-pane.tsx` summary panel:
- Single row per check, showing check name, status (✓/✗), duration.
- Tap to expand → stdout/stderr tail in a mono block.
- Overall status chip in the panel header.

If `quality_report` is null on a run row, the panel says "no quality
checks configured for this project" with a help link to the format.

### 9.4 Boundaries

- Quality checks run in the run's worktree, **after** the agent's
  auto-commit and **before** `mergeIntoMain`. The worktree state at
  check time matches what would land on main.
- The runner does **not** kill or roll back a run on quality failure
  in v0.2. The merge proceeds; the operator sees the failure in the
  summary and decides whether to revert.
- v0.3 introduces gating: a per-project `quality.yaml` flag like
  `gating: required` makes failures route through a new
  `quality_failure` decision card instead of merging.

-----

## 10. Operating contract delta

What v0.2 promises beyond v0.1:

- A drafting plan lives in the inbox until the operator freezes or
  abandons it. The operator may leave it indefinitely.
- A frozen plan is read-only. Changes require a new plan (for project
  spec) or a refinement plan (for tasks).
- A run with a `task_plan_id` reads the plan's draft as authoritative
  context. The agent is prompted to declare acceptance results and to
  flag drift from the planned `touches`.
- Quality signal results land on the run summary. v0.2 does **not**
  promise gating; quality failures inform but do not block.

What v0.2 does **not** promise:

- That the agent will never deviate from a frozen plan (it will
  occasionally; we surface drift in v0.3).
- That a project_spec plan, once frozen, can be re-iterated against
  an existing project. v0.2 freezes are one-shot per plan; iteration
  on a live project is Path-B `feature_plan` territory (v0.3+).
- That refinement plans always cleanly rewrite tasks. The freeze
  action for refinement modifies the task body and may emit
  followups; if the operator rejects the result, they create another
  refinement plan.

-----

## 11. Migration & backwards compatibility

### 11.1 Schema migration

Single migration `0005_plan_primitive.sql`:
- `CREATE TABLE plans (...)`
- `CREATE TABLE plan_comments (...)`
- Indexes.
- `ALTER TABLE runs ADD COLUMN task_plan_id text`
- `ALTER TABLE runs ADD COLUMN quality_report text`

No data backfill. Existing runs read as `task_plan_id IS NULL` and
behave exactly as v0.1.

### 11.2 Bootstrap path cutover

Hard cutover, not a feature flag:
- Pre-v0.2 triage approvals (decisions in `actioned` state with no
  associated plan) keep their projects unchanged.
- Post-v0.2 triage approvals (any `decisions.action` call after the
  upgrade) route through `plans.startProjectFoundry`. The decision
  is marked `actioned` immediately; the project materializes on plan
  freeze.
- `bootstrapProject` accepts both an idea+`spec_stub` (legacy direct
  call path, kept for tests and for Path-B feature plans later) and
  a frozen `project_spec` plan id (new path).

The "I want to skip planning and bootstrap immediately" affordance is
implicit: the agent's seeded draft from `spec_stub` is already a
valid plan; the operator can freeze without commenting. One extra
tap, but no second code path.

### 11.3 Quality signal opt-in

Quality is opt-in via the presence of `.factory/quality.yaml`:
- v0.1 projects don't have this file → no quality checks run, runs
  behave as today.
- v0.2 bootstrap seeds the file when stack detection hits.
- Operators can manually create the file in v0.1 projects to opt in.

### 11.4 Inbox card kinds

`DecisionCard` and `PlanCard` are separate components. The inbox
route renders both kinds in a single chronological list. There is no
"unified inbox card" abstraction — each kind has a card built around
its lifecycle. (CLAUDE.md "don't generalize before the second instance"
— we have two card types; we don't yet need a base.)

-----

## 12. Repo Layout — new files

```
apps/daemon/src/
  plans/
    iterate.ts            # runPlanIteration + per-kind prompt assembly
    prompts.ts            # prompt-key constants and templates lookup
    bootstrap-from-plan.ts  # adapter: frozen project_spec plan → bootstrapProject
  routers/
    plans.ts              # plansRouter
  workers/
    quality.ts            # runQualityChecks + types

apps/pwa/src/
  routes/
    plan-detail.tsx       # /plans/:id
  components/
    plan-card.tsx         # inbox card for drafting plans
    plan-draft-viewer.tsx # kind-specific structured draft renderer
    quality-report.tsx    # run summary subcomponent

packages/db/src/
  migrations/
    0005_plan_primitive.sql
    meta/0005_snapshot.json
  schema.ts (modified)

prompts/
  plan-project-spec-v1.md
  plan-task-plan-v1.md
  plan-refinement-v1.md
```

Modified existing files:

- `apps/daemon/src/routers/decisions.ts` — `decisions.action`
  approve-on-triage routes through `plans.startProjectFoundry`.
- `apps/daemon/src/routers/runs.ts` — submit reads task_plan and sets
  `task_plan_id`.
- `apps/daemon/src/workers/runner.ts` — plan-aware prompt; quality
  invocation; quality report persistence.
- `apps/daemon/src/workers/factory-status.ts` — optional `acceptance`
  field in parsed status.
- `apps/daemon/src/workers/submit.ts` — task_plan lookup at submit
  time.
- `apps/daemon/src/projects/bootstrap.ts` — `bootstrapProject`
  accepts a frozen plan id alternative input.
- `apps/pwa/src/app.tsx` — register `/plans/:id` route.
- `apps/pwa/src/routes/inbox.tsx` — merge plans + decisions.
- `apps/pwa/src/routes/decision-detail.tsx` — triage approve redirect.
- `apps/pwa/src/routes/task-detail.tsx` — plan section.
- `apps/pwa/src/routes/project-detail.tsx` — plans section.
- `apps/pwa/src/routes/live-pane.tsx` — plan chip + quality + plan
  acceptance results in summary.

-----

## 13. Implementation order (suggested)

A fresh-context Claude session should land v0.2 in this order. Each
step is verifiable in isolation (`bun run typecheck` + `bun test`):

1. **Schema + migration.** `plans`, `plan_comments`, modified `runs`.
   Verify migration applies cleanly on a v0.1 db copy.
2. **Plan iteration core.** `apps/daemon/src/plans/iterate.ts` and
   prompt templates. Unit tests with the `agentInvoker` test seam,
   parallel to existing triage tests.
3. **`plansRouter`.** All routes; tRPC integration tests for
   start/comment/freeze/abandon paths. No PWA changes yet.
4. **Triage approve cutover.** Modify `decisions.action`. Verify
   existing decision-router tests pass with adjusted expectations.
5. **Bootstrap-from-plan adapter.** `bootstrap-from-plan.ts` reads a
   frozen project_spec and calls existing `bootstrapProject` with
   the planned tasks.
6. **PWA Plan Detail + PlanCard + inbox merge.** End-to-end manual
   test: approve idea → comment on plan → freeze → land on project.
7. **Task plan flow.** Task-detail "expand" button; runner reads
   `task_plan_id`; `wrapPromptWithPlan`. Manual test: start a task
   with a plan; verify the prompt block appears in the run pane.
8. **Quality signal subsystem.** `quality.ts`, runner integration,
   `quality-report.tsx`. Bootstrap seeding of `.factory/quality.yaml`.
   Manual test: a passing run with quality results; a run with one
   failing check that still merges.
9. **Plan-aware factory-status.** Extend parser; render acceptance
   results in summary panel. Manual test: a run whose agent declares
   per-criterion results.
10. **Refinement plan UI** (if cheap; otherwise defer to v0.2.5).
    Task-detail "refine" button; refinement-plan freeze rewrites
    task body. Manual test: a completed run, refine, re-run.

Each step is mergeable independently; the v0.1 spine continues to work
throughout (a project created during step 4 still bootstraps, just via
the new path).

-----

## 14. Open questions

Carried from ADR-002 §"Open questions":
1. Latest-draft source of truth (column on plans vs. derived from
   latest comment).
2. Stale drafting plans surfaced as decisions (cron-y, may slip to
   v0.3).
3. Whether `design` warrants its own kind.
4. Plan-aware factory-status acceptance shape — committed in §6.2 but
   tunable during build.
5. Shared prompt-wrapper helper.

New v0.2-spec-level:

6. **Plan freeze and immediate run-submit.** Should freezing a
   `task_plan` automatically submit a run? Lean (this spec): no.
   Freeze and submit are separate operator actions; auto-advance can
   chain them but each is explicit. Reconsider if operators report
   the extra tap as friction.
7. **Stale frozen task plans.** If a task plan was frozen, the task
   body changed since, and a run is then submitted: the plan is
   stale. Lean: warn in the live-pane header but proceed; the
   operator can abort and create a refinement. Don't auto-invalidate.
8. **Refinement plan freeze: rewrite vs. emit followups vs. both.**
   The freeze action mutates the task body for `revisedAcceptance`
   and emits new task files for `followups`. If the agent returns
   neither, freeze is a no-op (just closes the plan). Lean: ship
   the all-three path; if `followups` proves rare in practice,
   trim later.
9. **Quality signal failure → decision card.** v0.2 keeps quality
   informational. If operators report consistently ignoring failed
   quality, promote to a `quality_failure` decision in v0.3 or
   earlier. Lean: don't pre-build the decision path.
10. **Multi-project quality config.** A monorepo with multiple
    workspaces may need check `cwd` overrides. The schema includes
    `cwd`; the seeded config picks the project root. Validate during
    build.

-----

## 15. What "done" looks like for v0.2

Two demo paths, each recorded on a phone (mirroring spec.md §15):

**Demo A — foundry + task plan + quality (must pass)**

1. Operator types an idea into the PWA.
2. Triage decision lands; operator taps Approve.
3. A drafting `project_spec` plan card appears in the inbox.
4. Operator opens the plan, comments "split task 2 into a UI piece
   and an API piece," sends.
5. Agent re-drafts; the task list now has the split. Operator taps
   Freeze.
6. Project page opens with the refined task list.
7. Operator opens task-001, taps "Expand task with a plan."
8. Plan opens with empty draft; agent's first turn populates steps,
   acceptance, touches. Operator comments once to add a risk; agent
   updates. Operator taps Freeze.
9. Operator returns to task-001, taps Start Run. The live pane shows
   the agent reading the frozen plan in its prompt.
10. Run completes. Run summary shows: `factory-status: done`,
    acceptance criteria with 3/3 met, quality report with typecheck
    pass / lint pass / test pass. Auto-merge to main succeeds.

**Demo B — refinement (ships v0.2 if cheap, else v0.2.5/v0.3)**

11. Operator opens task-002 result, taps Refine.
12. Refinement plan opens; operator types feedback ("the API contract
    should be REST not gRPC"); agent proposes revised acceptance and
    one followup task.
13. Operator taps Freeze. Task-002 body is rewritten with revised
    acceptance; a new task-005 is appended.
14. Operator submits a fresh run on task-002; the new run reads the
    revised body.

If demo A runs end-to-end without hand-holding, v0.2's spine is done.
Demo B is bonus.

-----

## 16. What v0.2 does **not** answer (carry to v0.3)

- Path-B `feature_plan` UI and flow.
- Project-level vision/conventions doc that runs read as background
  context (currently runs read whatever is in the worktree cold).
- Drift detection — runs that touched files outside `task_plan.touches`.
- Per-project quality rubric beyond commands (alignment-with-vision,
  coverage delta, etc.).
- Marinate scheduler for stale ideas, parked decisions, and stale
  drafting plans.
- Push notifications.
- In-app rubric/prompt editor (Monaco).
- Multi-iteration `createSession` runtime API.
- Codex/Gemini providers.
- Cross-project memory.

These remain on the `docs/vision.md` §6 / §6.1 slate.
