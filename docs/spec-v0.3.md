# Factory v0.3 — Specification

> **Scope:** v0.3 only — the changes layered on top of v0.1 + v0.2.
> **Companion docs:** `docs/spec.md` (v0.1, frozen), `docs/spec-v0.2.md`
> (v0.2, frozen), `docs/vision.md` (post-v0.1 direction), `docs/adr/003-audit-primitive.md`
> (the architectural commit this spec implements), `CLAUDE.md`
> (architectural contracts).
>
> Read `docs/spec.md` and `docs/spec-v0.2.md` once first if you have not.
> This document does not repeat earlier data models, runtime, or PWA
> conventions; it specifies only the v0.3 deltas.

-----

## 1. Theme & one-paragraph thesis

v0.1 proves the spine. v0.2 puts the planning unlock in front of every
significant code-changing run. v0.3 is the **living-projects unlock**:
projects accrue authored, versioned alignment artifacts (CLAUDE.md
always, VISION.md when the project warrants it) and a recurring
**audit primitive** keeps those artifacts honest. The same primitive
opens Path B — a `feature_plan` shipping a feature into an existing
project — and turns audit findings into the new "decision currency"
that promotes either to a refined `task_plan` / `feature_plan` or to
a quick captured bug. Factory remains a tool, not a gatekeeper of
value: every per-project artifact lives in the project repo, usable
without Factory in the loop.

-----

## 2. Goals & Non-Goals

### 2.1 Goals (v0.3)

- An **audit primitive** distinct from runs: read-mostly agent
  invocations that produce structured reports with severity-graded
  findings. Reports start Factory-internal; on operator approval,
  they commit to the project repo at `docs/internal/audits/`.
- Audit skills live in the project repo at
  `<project>/.factory/audits/<name>/SKILL.md`, version-controlled with
  the project's code.
- Selected audit findings promote, via a single Claude bridge
  invocation, to either a draft plan (heavyweight: iterate then
  freeze) or a bug task (lightweight: minimal capture, refine later).
- A new `tasks.create` mutation creates tasks directly (outside any
  plan freeze). All task creation paths in the daemon route through
  one task-IO module so future swaps to GitHub Issues / beads are a
  single-file change.
- The reserved `feature_plan` plan kind is **implemented**. Triggered
  from the project page or from Path-B idea capture. Freeze emits
  tasks into the existing project. The forge-style **vision filter**
  (identity / principle / phase / replacement) is a freeze
  precondition for tier ≥ personal.
- A new `project_vision` plan kind authors `docs/internal/VISION.md`.
  Auto-triggered after `project_spec` freeze for tier ≥ personal;
  opt-in for tinker. `project_vision` plans **supersede** prior
  frozen vision plans (the supersession chain is the project's
  architectural diary).
- **Plan supersession** is a generic mechanic on the existing plan
  primitive: any frozen plan can be superseded by a new plan in the
  same kind+target. The superseded plan stays as audit trail.
- **Drift detection**, **task sweep**, **code-review**, **docs-audit**
  ship as default audit-skill templates. Tinker projects skip them;
  personal+ projects are prompted to install during a new
  **project-deepening flow**.
- Tier (`tinker | personal | share | productize`) graduates from a
  v0.1-vestigial axis to a meaningful one gating onboarding depth and
  default audit installation.
- Factory ships an **architectural extensibility posture**: every
  v0.3 storage seam (audit reports, audit skills, bug tasks) is
  shaped so a future swap to a remote store is a one-file change.

### 2.2 Non-Goals (v0.3)

- Audit scheduling. v0.3 audits are on-demand. v0.4's marinate
  scheduler hosts cadence.
- Audits as merge gates. v0.3 audits are advisory; failing audit
  findings do not block runs or merges.
- Auto-prepending VISION.md (or any project doc) to run prompts.
  CLAUDE.md is the agent's reading list; runs follow references.
- Cross-project audit history / pattern detection. Out of scope until
  v0.5 cross-project memory.
- AI-authored audit skills. Operators author skills (with agent help
  via a guided plan, or just from templates). Factory does not
  auto-generate skills.
- Findings as their own DB table. Stays inline JSON on the audit row
  in v0.3.
- Push notifications, in-app prompt editor, weekly digest, runtime
  metrics. All v0.4+ ergonomics.
- Quality tier promotion mechanic (`tinker → personal → share`).
  Tier is editable on the project header in v0.3; the *promotion
  gates* in spec.md §13 v0.3 are deferred.

-----

## 3. Architecture deltas

v0.1 + v0.2 architecture stands. v0.3 adds:

- **Audits module.** `apps/daemon/src/audits/` mirrors
  `apps/daemon/src/plans/`: `iterate.ts` (run an audit skill),
  `findings.ts` (parse findings from the report), `promote.ts` (the
  bridge invocation for findings → plan/bug), `report-commit.ts`
  (commit approved report to project repo). Read-only audits invoke
  via `claude --print` (no worktree); exec audits invoke via
  `runtime.spawn` (worktree, `--dangerously-skip-permissions`,
  factory-status honesty contract). Both reuse v0.2's
  session-resume mechanic for operator follow-up turns on the
  report.
- **Audit-skill loader.** `apps/daemon/src/projects/audit-skills.ts`:
  one entry point each for listing skills in a project and reading a
  skill's body. Future remote-skill-registry is a provider swap.
- **Task-IO consolidation.** `apps/daemon/src/projects/tasks.ts`
  gains `createTask` (write path). `bootstrap.ts` and `plans/refine.ts`
  refactor to call it instead of writing files directly. v0.3 new
  flows (bug capture, audit-finding promotion, feature-plan freeze)
  call it from the start. Net effect: one place that knows the task
  storage format.
- **Audit-report committer.** `apps/daemon/src/audits/report-commit.ts`:
  on approval, writes the report markdown to
  `<project>/docs/internal/audits/<YYYY-MM-DD>-<slug>.md`, runs
  `commitAllChanges` through the v0.1 worktree helper, commits with a
  conventional `docs: approve audit report — <slug>` message. The
  project repo is canonical; the Factory row becomes index-only.
- **Plan supersession.** No new module — handled inline in
  `plans/freeze.ts` (or wherever freeze actions live today). When a
  new plan in the same kind+target as a frozen plan is frozen, the
  prior frozen plan's status moves to `superseded` (new status) and
  carries a `supersededBy` pointer.
- **Tier-aware bootstrap branching.** `bootstrap-from-plan.ts` reads
  the plan's `tier` field and conditionally triggers a
  `project_vision` plan after `project_spec` freeze for tier ≥
  personal.

-----

## 4. Data model deltas

### 4.1 New table: `audits`

| column                  | type                         | notes |
|-------------------------|------------------------------|-------|
| `id`                    | text PK                      | cuid2 |
| `project_id`            | text NOT NULL → `projects(id)` | every audit is project-scoped |
| `skill_name`            | text NOT NULL                | matches dir name under `.factory/audits/` |
| `skill_version`         | text NOT NULL                | git SHA of `SKILL.md` at audit-start time |
| `status`                | text NOT NULL                | enum: `running` \| `completed` \| `reviewed` \| `approved` \| `rejected` \| `failed` |
| `started_at`            | integer NOT NULL             | epoch ms |
| `completed_at`          | integer NULL                 | |
| `reviewed_at`           | integer NULL                 | first-open by operator |
| `approved_at`           | integer NULL                 | |
| `rejected_at`           | integer NULL                 | |
| `report_markdown`       | text NULL                    | populated on completion |
| `findings`              | text NULL (JSON)             | array of AuditFinding (see §4.3) |
| `approved_report_path`  | text NULL                    | repo-relative, set on approval |
| `claude_session_id`     | text NULL                    | for follow-up turns on the report (v0.2 mechanic) |
| `prompt_version`        | text NULL                    | session invalidation key (v0.2 mechanic) |
| `worktree_path`         | text NULL                    | exec audits only; null for read-only |
| `tmux_session_name`     | text NULL                    | exec audits only |
| `pane_log_path`         | text NULL                    | exec audits only; mirrors `runs.rawLog` |

Indexes:
- `audits_project_status_idx` on `(project_id, status)`
- `audits_status_started_idx` on `(status, started_at)` for inbox surfacing

### 4.2 Modified table: `plans`

Add columns (already includes v0.2's session-resume columns):

| column          | type        | notes |
|-----------------|-------------|-------|
| `tier`          | text NULL   | enum: `tinker` \| `personal` \| `share` \| `productize`; carried into bootstrap |
| `superseded_by` | text NULL → `plans(id)` | set when a newer plan in the same kind+target supersedes this one |

Add new value to the `status` enum (TS-only, sqlite stores as text):
- `superseded` (new) — a frozen plan was replaced by a newer one. Audit trail preserved.

### 4.3 TypeScript shapes

```typescript
// New plan kind. Reuses the PlanDraft union pattern from v0.2.
type PlanKind =
  | "project_spec"
  | "task_plan"
  | "refinement"
  | "feature_plan"     // v0.3 implements (was reserved in v0.2)
  | "project_vision";  // v0.3 new

type PlanStatus =
  | "drafting"
  | "frozen"
  | "abandoned"
  | "superseded";      // v0.3 new

interface FeaturePlanDraft {
  kind: "feature_plan";
  // The vision-filter result. Populated on each agent turn; read by
  // the freeze mutation as a precondition for tier ≥ personal.
  visionFilter: {
    identity: { passes: boolean; reasoning: string };
    principle: { passes: boolean; reasoning: string };
    phase: { passes: boolean; reasoning: string };
    replacement: { passes: boolean; reasoning: string };
  };
  goal: string;             // operator-stated; immutable after creation
  summary: string;
  tasks: TaskSpec[];        // emitted into the existing project on freeze
  unknowns: string[];
  risks: string[];
}

interface ProjectVisionDraft {
  kind: "project_vision";
  identity: string;         // 2-3 sentence "what it is"
  audience: string;
  problem: string;
  designPrinciples: { name: string; meaning: string }[];
  outOfScope: string[];
  personality: string | null;
  roadmap: { phase: string; bullets: string[] }[];
  priorArt: string[];
}

interface AuditFinding {
  id: string;               // cuid2, stable across promote calls
  severity: "critical" | "major" | "minor" | "enhancement";
  title: string;            // <120 chars
  body: string;              // markdown
  filePath: string | null;
  line: number | null;
  promotedTo:
    | { kind: "plan"; planId: string }
    | { kind: "task"; taskId: string }
    | null;
}

interface AuditSkillFrontmatter {
  name: string;
  description: string;
  kind: "read-only" | "exec";
  needsWorktree: boolean;
  defaultSeverityGrade: "enabled" | "disabled";
}
```

### 4.4 Migration

Single migration: `packages/db/src/migrations/0007_audit_primitive.sql`.

```sql
CREATE TABLE `audits` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `skill_name` text NOT NULL,
  `skill_version` text NOT NULL,
  `status` text NOT NULL DEFAULT 'running',
  `started_at` integer NOT NULL,
  `completed_at` integer,
  `reviewed_at` integer,
  `approved_at` integer,
  `rejected_at` integer,
  `report_markdown` text,
  `findings` text,
  `approved_report_path` text,
  `claude_session_id` text,
  `prompt_version` text,
  `worktree_path` text,
  `tmux_session_name` text,
  `pane_log_path` text,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);

CREATE INDEX `audits_project_status_idx` ON `audits`(`project_id`, `status`);
CREATE INDEX `audits_status_started_idx` ON `audits`(`status`, `started_at`);

ALTER TABLE `plans` ADD `tier` text;
ALTER TABLE `plans` ADD `superseded_by` text REFERENCES `plans`(`id`);
```

The `plans.status` enum is TS-only — no SQL change for the new
`superseded` value.

Backwards compat: pre-v0.3 plans have `tier = NULL` (treated as
`tinker` for filter purposes; the agent prompts ask explicitly when
tier-routing matters).

-----

## 5. API — tRPC routes

### 5.1 New router: `auditsRouter` (mounted as `audits`)

Procedures:

- **`list`** (query) — `{ projectId: string, status?: AuditStatus[] }` →
  `Audit[]`. Default ordering: most recent first. PWA project page
  uses this for the audits tab.
- **`get`** (query) — `{ id: string }` → `Audit | null`.
- **`inbox`** (query) — `{}` → `Audit[]`. Returns `completed` audits
  across all projects, ordered by `completed_at desc`. Surfaced in
  the inbox alongside drafting plans + pending decisions.
- **`listSkills`** (query) — `{ projectId: string }` →
  `AuditSkillFrontmatter[]`. Lists skills available in the project's
  `.factory/audits/` directory.
- **`submit`** (mutation) — `{ projectId: string, skillName: string }` →
  `{ auditId: string }`. Spawns the audit (read-only via
  `claude --print` or exec via `runtime.spawn` based on skill kind).
  Inserts an `audits` row in `running` state and broadcasts the
  initial event on `/ws/inbox`.
- **`comment`** (mutation) — `{ auditId: string, body: string }` →
  `{ audit: Audit }`. The operator can ask follow-up questions on a
  `completed` report. Resumes the captured `claudeSessionId` (v0.2
  mechanic). Replies append to the report markdown as a
  "Discussion" section. Does *not* re-run the audit — that's a fresh
  submission.
- **`approve`** (mutation) — `{ auditId: string }` →
  `{ audit: Audit, reportPath: string }`. Status `completed`/`reviewed`
  → `approved`. Commits the report markdown to the project repo at
  `docs/internal/audits/<YYYY-MM-DD>-<slug>.md` and records
  `approvedReportPath`.
- **`reject`** (mutation) — `{ auditId: string, reason?: string }` →
  `{ audit: Audit }`. Marks rejected, no repo write.
- **`markReviewed`** (mutation) — `{ auditId: string }` →
  `{ audit: Audit }`. Idempotent — first call sets `reviewedAt`.
- **`promoteFindings`** (mutation) — `{ auditId: string, findingIds: string[] }` →
  `{ recommendation: "plan" | "bug", planId?: string, taskId?: string }`.
  Invokes the bridge claude call. On `plan` recommendation, creates a
  drafting `task_plan` or `feature_plan` (depending on scope inferred
  by the bridge), seeds the draft with the findings as goal context,
  and returns the new `planId`. On `bug` recommendation, creates a
  task via `tasksRouter.create` (see §5.2), labels it
  `bug` + `needs-refinement`, and returns the new `taskId`. Updates
  the audit's findings JSON to mark each promoted finding's
  `promotedTo` pointer.

### 5.2 New router: `tasksRouter.create` (under existing `projectsRouter.tasks`)

Existing nested router gains:

- **`create`** (mutation) — `{ projectId: string, title: string, body: string, labels?: string[], parent?: string }` →
  `{ task: TaskFile }`. Writes a new task file via
  `tasks.createTask(projectPath, payload)`. The IDs are monotonic per
  v0.1 spec (`task-NNN`); the helper picks the next available
  number. Returns the parsed `TaskFile`.

This is the first task-creation path that doesn't go through a plan
freeze. Used by:
- `auditsRouter.promoteFindings` (bug path)
- The PWA's project-page "+ task" button (new)
- Future: external idea capture (Telegram bot, etc.) for ideas
  attached to an existing project.

### 5.3 Modified routes

- **`plansRouter.freeze`** — adds vision-filter precondition for
  `feature_plan` kind when the project's tier is `personal` or
  higher. Throws `tRPCError({ code: 'FAILED_PRECONDITION' })` if any
  filter test fails. Operator must iterate the plan until all four
  pass.
- **`plansRouter.freeze`** — when freezing a plan that has a prior
  frozen plan in the same kind+target, the prior plan's status moves
  to `superseded` and `supersededBy` is set. Atomic in the same
  transaction as the new freeze.
- **`projectsRouter.update`** — gains a `tier` field. Editable from
  the project header.
- **`decisionsRouter.action`** (approve on triage) — passes the
  triage payload's `tier` field through to the created `project_spec`
  plan row.

### 5.4 WS events on `/ws/inbox`

New event kinds:

```typescript
type DaemonInboxEvent =
  // ... existing kinds (decision_*, plan_*, idea_capture)
  | { kind: "audit_started"; auditId: string; projectId: string; skillName: string }
  | { kind: "audit_completed"; auditId: string; projectId: string }
  | { kind: "audit_approved"; auditId: string; projectId: string; reportPath: string }
  | { kind: "audit_rejected"; auditId: string; projectId: string }
  | { kind: "finding_promoted"; auditId: string; findingId: string; promotedTo: { kind: "plan" | "task"; id: string } };
```

Audit pane events broadcast on `/ws/pane` (exec audits only) reuse
the v0.1 raw-bytes channel. Read-only audits stream their text on
`/ws/events` as structured `audit_text` events.

-----

## 6. Runtime deltas

### 6.1 Audit invocation paths

Two paths, picked by skill `kind`:

**Read-only audits** (`kind: read-only`):

```
audits.submit
  → render audit prompt from SKILL.md (with placeholder substitution
    for project context: README, CLAUDE.md, prior audit summaries,
    git log tail)
  → invokeClaudeJson(prompt, { budgetSeconds: 300 })
       (reuses apps/daemon/src/plans/invoke-claude.ts)
  → parse fenced JSON envelope: { reportMarkdown, findings }
  → persist audit row, status='completed', emit audit_completed
```

No worktree, no tmux, no commits. Mirrors v0.2 plan iteration
exactly. Session id captured for follow-up turns.

**Exec audits** (`kind: exec`):

```
audits.submit
  → ensure worktree at ~/.factory/worktrees/<slug>/audit-<auditId>
       (note: separate from per-run worktrees; audits don't merge)
  → spawn via runtime.spawn with skill prompt + --dangerously-skip-permissions
  → factory-status honesty contract applies: agent must declare
       done | blocked | failed in fenced JSON
  → audit-specific footer: agent must additionally emit reportMarkdown
       and findings in the same JSON block
  → on done: parse, persist, audit_completed event
  → on blocked / failed / null parse: status='failed', no report
```

Exec audits use the same worktree primitive as runs but with a
distinguishing path prefix (`audit-<auditId>` vs `run-<runId>`) so
they can coexist. Worktrees are torn down on audit completion (no
post-merge state to preserve, unlike runs).

### 6.2 Audit-skill prompt assembly

Audit prompts are rendered from the skill body with placeholder
substitution. Skill body uses Mustache-light syntax (matching v0.2
plan prompts):

```markdown
# {{SKILL_NAME}} — {{PROJECT_NAME}}

{{SKILL_BODY}}

## Project context

- Vision (excerpt): {{VISION_EXCERPT}}
- CLAUDE.md (excerpt): {{CLAUDE_MD_EXCERPT}}
- Recent commits: {{RECENT_COMMITS}}
- Prior audit summaries: {{PRIOR_AUDITS}}

## Output contract

Emit a single fenced JSON block with this shape:

```json
{
  "reportMarkdown": "<full markdown report — operator-readable>",
  "findings": [
    {
      "severity": "critical|major|minor|enhancement",
      "title": "<short headline>",
      "body": "<markdown details>",
      "filePath": "<repo-relative or null>",
      "line": <number or null>
    }
  ]
}
```

(continued — the factory-status footer is appended automatically.)
```

The skill author writes the *body* — the audit's domain-specific
instructions, criteria, examples. Factory adds the project-context
preamble and the output-contract footer. This keeps skills focused
on what to audit, not how to format output.

### 6.3 Plan-aware run prompts (no change from v0.2)

v0.3 does not auto-prepend VISION.md or audits to run prompts. The
v0.2 plan-aware prompt assembly stands. Runs read CLAUDE.md as their
operating manual; CLAUDE.md references VISION.md / prior audits where
applicable, and the agent loads them by following the reference.

### 6.4 Vision filter (feature_plan freeze precondition)

For `feature_plan` plans on projects with `tier ≥ personal`, the
agent's prompt template instructs it to populate the `visionFilter`
field on every draft. Each test (identity, principle, phase,
replacement) must `passes: true` to freeze. `plansRouter.freeze`
checks this before applying the freeze action.

For `tier == tinker` projects, the precondition is skipped. The
agent still populates `visionFilter` if it can, but freeze proceeds
regardless.

The four tests, copied from forge's `/product` skill:

1. **Identity:** does this make the project more completely what it's
   trying to be, per VISION.md?
2. **Principle:** does it comply with each design principle?
3. **Phase:** is the foundation in place — is this the right phase for
   this work?
4. **Replacement:** does this project need to own this, or is a
   specialized tool already better?

VISION.md must exist for the filter to apply. If VISION.md is absent
on a tier ≥ personal project, freeze prompts the operator to either
author one (triggering a `project_vision` plan) or downgrade the
project's tier.

### 6.5 Plan supersession

When `plansRouter.freeze` runs:

```typescript
// Pseudocode
const newPlan = await freezePlan(planId);
const targetKey = `${newPlan.kind}:${newPlan.projectId ?? ''}:${newPlan.taskId ?? ''}`;
const priorFrozen = await db.query.plans.findFirst({
  where: and(
    eq(plans.kind, newPlan.kind),
    eq(plans.status, 'frozen'),
    /* same target keys */
    not(eq(plans.id, newPlan.id)),
  ),
});
if (priorFrozen) {
  await db.update(plans).set({
    status: 'superseded',
    supersededBy: newPlan.id,
  }).where(eq(plans.id, priorFrozen.id));
}
```

The PWA renders superseded plans in a collapsed "history" section on
the relevant page (project for `project_vision`, task for `task_plan`).

### 6.6 Audit report commit

On `audits.approve`:

1. Determine target path: read `<project>/.factory/audits.yaml` for
   `report_path` override; default to `docs/internal/audits/`.
2. Compute filename: `<YYYY-MM-DD>-<skill-slug>.md` (date is approval
   date; multi-approval-same-day appends `-2`, `-3`, etc.).
3. Write `reportMarkdown` to that path.
4. Run `commitAllChanges` in the project workdir with message
   `docs: approve audit report — <skill-name>`.
5. Persist `approvedReportPath` on the audit row.
6. Broadcast `audit_approved` event.

Failure modes (dirty tree, missing repo, etc.) abort the approval and
return an error to the operator. Audit row stays in `completed` /
`reviewed` so the operator can retry after fixing the project state.

-----

## 7. Audit-skill prompt templates (Factory ships these)

Templates live at `docs/audit-skill-templates/<name>/SKILL.md` (and
optional `references/`). The operator copies them into a project's
`.factory/audits/` via the project-deepening flow or by hand.

Factory ships four templates in v0.3:

### 7.1 `code-review` (kind: exec)

Audits the most recent N runs' merged commits for: logic errors,
security concerns, convention adherence (per `CLAUDE.md`), test
coverage gaps. Findings include file/line refs.

### 7.2 `docs-audit` (kind: read-only)

Audits VISION.md (if present), CLAUDE.md, README.md for: stale
references, contradictions with current code, missing entries that
recent merged work warrants.

### 7.3 `task-sweep` (kind: read-only)

Scores every open task in `.factory/work/` against a quality
checklist (template ships a default checklist; operator
customizable per project). Findings flag tasks needing refinement.
Promote-to-bug is the typical next step (the bug *is* the
"refine this task" reminder).

### 7.4 `drift-check` (kind: read-only)

Reads the most recent completed run on a task with a frozen
`task_plan`. Compares the run's actual touched files against the
plan's declared `touches`. Findings = files touched outside the plan.

-----

## 8. PWA — new screens & UX

### 8.1 Inbox (modified — third stream)

The v0.2 inbox merged decisions + drafting plans. v0.3 adds a third
stream: `audits.inbox` (completed audits awaiting review).

Inbox card kinds (existing + new):

- `triage` decision (v0.1)
- `blocked_run` decision (v0.1)
- `merge_failure` decision (v0.1)
- `tag_change` decision (v0.1)
- `drafting_plan` (v0.2, all kinds)
- `completed_audit` (v0.3 new) — surfaces a completed audit for
  review

Card affordances for `completed_audit`:
- skill name + project name (mono / display split)
- finding-count chip with severity histogram (e.g. `2C 5M 3m 1e`)
- tap → audit pane

### 8.2 Project page — audits tab

New tab on `/projects/:id` alongside existing tabs (overview, tasks,
runs, plans).

Sections:
- **Available skills** — list from `audits.listSkills`. Each row has a
  "run" button. Skills that ran recently show last-run-at + status.
- **Recent audits** — `audits.list({ projectId, status: ['running', 'completed', 'reviewed'] })`
  (current + recently completed). Tap → audit pane.
- **Approved reports** — collapsed by default. List of approved audit
  reports with link to the committed file in the repo. Tap → opens
  the file (renders markdown in-app).

### 8.3 Audit pane (`/projects/:id/audits/:auditId`)

Mirrors the v0.1 live pane shape:

- **Header**: skill name, status chip, project name, `mark reviewed` /
  `approve` / `reject` actions per status.
- **Body** (running): xterm pane (exec audits) or scrolling text
  output (read-only audits).
- **Body** (completed/reviewed/approved): rendered report markdown +
  findings list. Each finding card has severity chip, title, body,
  optional file ref, and (for completed/reviewed) a "promote" button.
- **Footer** (completed/reviewed): operator comment box. Posting
  resumes the captured claude session and the agent's reply appends
  to the report under a "Discussion" section.

### 8.4 Findings → action (modal flow)

Triggered by selecting one or more findings (checkbox) and tapping
"promote." Flow:

1. Modal opens with the selected findings summarized.
2. "Evaluating…" — bridge claude call runs. Returns
   `{ recommendation, draft }`.
3. Modal shows the recommendation and an editable draft (plan goal
   text or bug title+body).
4. Two action buttons: "create plan" or "create bug" (one is
   highlighted as the recommendation; the other is always available).
5. On confirm: corresponding mutation runs. Findings update with
   `promotedTo` pointers. Modal closes; PWA navigates to the new
   plan or task.

### 8.5 Project deepening flow (`/projects/:id/deepen`)

Operator-triggered route. Step-through wizard:

1. **Tier confirmation** — "this project is currently `<tier>`. Is
   that still right?" Re-asks if changed.
2. **Vision** — if no `docs/internal/VISION.md` exists, prompt to
   start a `project_vision` plan. (Skip if exists.)
3. **Audit skills** — checklist of templates Factory ships, with
   recommendations per tier. Operator picks; for each picked, copy the
   template into `<project>/.factory/audits/<name>/`.
4. **Confirm + commit** — single conventional commit:
   `chore: install factory audit skills` (skills) or
   `docs: add project vision (factory plan #<id>)` (vision freeze).

Each step is independently completable; the operator can exit and
return.

### 8.6 Plan supersession UX

On a frozen plan's detail page, if a newer plan supersedes it, render
a banner: "Superseded by plan #<newId>" with a link.

On a project_vision page, the supersession chain renders as a
chronological list — most recent at the top, prior versions
collapsible. This is the project's architectural diary.

`task_plan` and `refinement` plans get the same banner treatment but
no chain UI (the count rarely exceeds 2-3 per task).

### 8.7 Project header — tier picker

Tier was always present on projects but invisible. v0.3 surfaces it
as a chip in the project header with a click-to-edit affordance:

```
[ tinker ▼ ]   ← chip dropdown
```

Changing tier triggers a confirmation if the new tier requires
artifacts the project doesn't have (e.g. tier ≥ personal without
VISION.md). The confirmation offers to launch the deepening flow.

-----

## 9. Findings flow — bridge claude invocation

The `auditsRouter.promoteFindings` bridge call is small but
load-bearing. Its prompt:

```
You are deciding how an operator should act on the following audit
findings. The operator has selected these specific findings to address.

Project: <name> (tier: <tier>)
Audit skill: <skill-name>
Project vision (excerpt): <vision excerpt or "no vision doc">

Findings selected:
<findings as markdown — title, severity, body, file refs>

Decide:
1. Are these findings tractable as a single coherent unit of work?
   - If yes and the work is task-scoped: recommend "plan" with
     kind="task_plan" and draft a goal statement.
   - If yes and the work spans multiple tasks / is feature-shaped:
     recommend "plan" with kind="feature_plan" and draft a goal.
   - If no, or the work is too small to plan: recommend "bug" and
     draft a one-paragraph task body.

Emit a fenced JSON block:

{
  "recommendation": "plan" | "bug",
  "planKind": "task_plan" | "feature_plan" | null,
  "goal": "<plan goal — only when recommendation=plan>",
  "taskTitle": "<short title — only when recommendation=bug>",
  "taskBody": "<markdown body — only when recommendation=bug>",
  "reasoning": "<one paragraph explaining the choice>"
}
```

The `reasoning` field is shown to the operator in the modal so they
can override the recommendation with context.

Budget: 60s (short — this is a routing call, not a substantive
analysis).

-----

## 10. Operating contract delta

New architectural contracts to add to `CLAUDE.md`:

- **Audits are read-mostly. Audits never auto-merge code.** Audits
  produce reports; reports promote to plans or bugs; plans freeze and
  drive runs; runs auto-merge per v0.1. The audit primitive is
  upstream of the run primitive; never inverted.
- **Per-project artifacts are repo-canonical, not Factory-canonical.**
  Audit skills, approved audit reports, vision docs, CLAUDE.md, task
  files all live in the project repo. Factory's DB rows index them
  for fast queries; if the DB is wiped, project value is preserved.
  Storage seams must remain extensible without acrobatics — see
  §10.1.
- **CLAUDE.md is the agent's reading list, not a magic prepend.**
  Factory does not auto-inject doctrine into prompts. Runs read
  CLAUDE.md as their operating manual; the agent loads VISION.md,
  prior audit reports, etc. by following references in CLAUDE.md.
  When v0.3 ships VISION.md, the bootstrap-time CLAUDE.md gains a
  reference. The agent does the rest.
- **Tier is meaningful from v0.3 forward.** Tier gates onboarding
  depth, default audit installation, and the `feature_plan` vision
  filter. `tinker` projects skip ceremony; `personal` projects get
  vision + lightweight audits; `share` / `productize` get the full
  treatment.

### 10.1 Storage extensibility seams (v0.3 commitment)

Each storage seam has exactly one module that knows the storage
format. New flows route through that module:

| Artifact | Single-point-of-truth module | Future swap target |
|----------|------------------------------|--------------------|
| Tasks | `apps/daemon/src/projects/tasks.ts` | GitHub Issues, beads |
| Audit skills (read) | `apps/daemon/src/projects/audit-skills.ts` | remote skill registry |
| Audit reports (write to repo) | `apps/daemon/src/audits/report-commit.ts` | gist, external doc store |
| Project doctrine (read) | (no centralized read; agent follows refs from CLAUDE.md) | n/a — already extensible |

v0.3 work explicitly refactors `bootstrap.ts` and `plans/refine.ts`
to consume the task-IO module's new `createTask` function. No other
v0.3 consumers write task files directly.

-----

## 11. Migration & backwards compatibility

- **Existing projects** (no tier) treated as `tinker` for
  filter / default-audit purposes. Operator can edit tier from the
  project header.
- **Existing frozen plans** stay frozen; supersession is opt-in for
  new plans only.
- **Existing runs / quality reports** unchanged.
- **No `.factory/audits/` directory** in existing projects — that's
  fine. `audits.listSkills` returns empty; UI shows "no audit skills
  installed; run /deepen to add some."
- **Migration 0007** is additive (new table + nullable columns).
  Applies cleanly to a v0.2 DB.

-----

## 12. Repo layout — new files

```
docs/
├── audit-skill-templates/        # NEW — templates Factory ships
│   ├── code-review/
│   │   ├── SKILL.md
│   │   └── references/
│   ├── docs-audit/
│   │   └── SKILL.md
│   ├── task-sweep/
│   │   ├── SKILL.md
│   │   └── references/checklist.md
│   └── drift-check/
│       └── SKILL.md
├── adr/
│   └── 003-audit-primitive.md    # NEW
├── spec-v0.3.md                   # NEW (this file)
└── ...

apps/daemon/src/
├── audits/                        # NEW
│   ├── iterate.ts                 # invoke skill, parse report, persist
│   ├── findings.ts                # parse fenced JSON, validate
│   ├── promote.ts                 # bridge claude → plan|bug
│   ├── report-commit.ts           # approve → repo write + commit
│   └── prompts.ts                 # template assembly
├── projects/
│   ├── audit-skills.ts            # NEW — skill loader
│   └── tasks.ts                    # MODIFIED — add createTask
└── routers/
    └── audits.ts                  # NEW

apps/pwa/src/
├── routes/
│   ├── audit-pane.tsx             # NEW
│   ├── audit-list.tsx             # NEW (project tab)
│   ├── audit-deepen.tsx           # NEW (project deepening flow)
│   └── ...
└── components/
    ├── finding-card.tsx           # NEW
    ├── promote-findings-modal.tsx # NEW
    ├── tier-picker.tsx            # NEW
    └── ...

packages/db/src/
├── migrations/
│   └── 0007_audit_primitive.sql   # NEW
└── schema.ts                       # MODIFIED — audits table, plans cols

prompts/
├── plan-feature-plan-v1.md        # NEW (was reserved)
├── plan-project-vision-v1.md      # NEW
└── audit-bridge-v1.md             # NEW (the findings → action bridge)
```

-----

## 13. Implementation order (suggested)

Each step is independently typecheckable + testable. Each builds on
the previous.

1. **Schema + migration.** `audits` table, `plans.tier`,
   `plans.superseded_by`. Drizzle generate; rename to
   `0007_audit_primitive.sql`. Apply to fresh DB; verify v0.2 → v0.3
   upgrade is clean.
2. **Task IO consolidation.** Add `createTask` to `tasks.ts`.
   Refactor `bootstrap.ts` and `plans/refine.ts` to call it. Add a
   `tasksRouter.create` mutation. Test: bug capture (create + label).
3. **Audit-skill loader + audits module shell.**
   `projects/audit-skills.ts`, `audits/iterate.ts` (read-only path
   first; exec path stubs throw `not implemented`). New
   `auditsRouter` with `list`, `get`, `submit`, `markReviewed` (no
   approve/promote yet).
4. **Read-only audit invocation end-to-end.**
   `claude --print` invocation reusing `plans/invoke-claude.ts`.
   Parse fenced JSON. Persist report + findings. Test with a mock
   skill that returns a known report.
5. **Audit pane PWA.** New route, status-based body rendering,
   findings list. WS events for `audit_started`/`audit_completed`.
6. **Approve / reject + report commit.** Implement `approve` mutation.
   Wire up `report-commit.ts` (write file, run `commitAllChanges`).
   Test: report file exists in worktree on disk after approval; v0.1
   merge mechanic untouched.
7. **Findings → action bridge.** `audits/promote.ts` + the modal in
   PWA. Test both recommendation paths (plan + bug) with mock
   bridge responses.
8. **Default audit-skill templates.** Author the four templates
   (`code-review`, `docs-audit`, `task-sweep`, `drift-check`) under
   `docs/audit-skill-templates/`. Real prompts; test by hand against
   factory's own repo.
9. **Plan supersession.** Modify `plans.freeze` to detect prior
   frozen plans + transition to `superseded`. PWA banner + history
   list. Test with two consecutive `task_plan` freezes on the same
   task.
10. **`feature_plan` kind.** Implement the prompt template, the
    coerce function in `plans/iterate.ts`, the freeze action that
    emits tasks via `tasks.createTask`. Test: idea → triage →
    project bootstraps → operator clicks "ship feature" on project
    page → feature_plan iterates → freeze → tasks land.
11. **`project_vision` kind.** Plan template, freeze writes
    `docs/internal/VISION.md`. Auto-trigger after `project_spec`
    freeze for tier ≥ personal. Test: full demo A from §15 below.
12. **Tier picker + project deepening flow.** Project header chip,
    deepening route. Test: bring an existing tinker project to
    personal — vision + audits installed.
13. **Vision filter.** Add to `feature_plan` agent prompt; freeze
    precondition. Test: on a personal-tier project, feature_plan with
    a failing identity test refuses to freeze.
14. **Exec audit path.** `runtime.spawn` integration. Worktree per
    audit. factory-status footer. Test: a `code-review` audit
    actually runs `git log` + `bun test` and produces findings.
15. **Final verification.** `bun run typecheck` + `bun test` +
    `bunx biome check .` clean. PWA builds. Demo paths from §14
    pass.

Step 14 (exec audits) is gated by step 4-7 (read-only audits)
working — if read-only audits don't ship cleanly, exec is over-budget
and slips to v0.3.5.

-----

## 14. What "done" looks like for v0.3

Three demo paths, each recorded on a phone (mirroring spec.md §15
and spec-v0.2.md §15):

### Demo A — vision + feature_plan + audit (must pass)

1. Operator opens an existing `personal`-tier project that has
   completed several runs.
2. Project page shows VISION.md is missing. Operator launches
   deepening flow.
3. `project_vision` plan starts in the inbox. Operator iterates with
   the agent (Q&A-shaped). After 2-3 turns, freezes.
4. `docs/internal/VISION.md` lands in a `docs:` commit. Project page
   reflects vision present.
5. Operator launches a `feature_plan` from the project page. Goal:
   "add export-to-markdown command."
6. Agent iterates the plan. Vision filter populates; first turn
   fails the principle test ("violates simplicity-over-features
   principle"). Operator pushes back. Agent revises.
7. All four filter tests pass. Operator freezes. Two new tasks land
   in the project.
8. Operator runs `task-sweep` audit. Report flags the new tasks for
   refinement (acceptance criteria thin). Operator promotes findings
   → bug → bug task created.
9. Operator opens the bug task, launches a `refinement` plan,
   freezes. Task body now has fleshed-out acceptance criteria.
10. Operator submits a run on the refined task. Run completes,
    auto-merges per v0.1.

### Demo B — drift detection (must pass)

11. Operator runs the `drift-check` audit on a recently completed
    run (the one from demo A step 10).
12. Audit reports clean — no drift. Operator approves. Report
    commits to `docs/internal/audits/<date>-drift-check.md`.
13. Operator runs a second feature_plan that intentionally touches
    files outside its `touches` list. Run completes.
14. Drift-check audit on that run finds drift. Operator approves
    with the drift findings; promotes the largest finding to a bug
    ("review unauthorized scope expansion in worker.ts").

### Demo C — supersession (must pass)

15. Operator iterates a fresh `project_vision` plan (different
    project from demo A). Freezes.
16. Three weeks later (in walltime; in the demo, immediately),
    operator returns to update the vision. New `project_vision`
    plan starts in the inbox.
17. Operator iterates, freezes. The first vision plan transitions
    to `superseded`; the second is now authoritative. Project page
    renders the supersession chain with both versions visible.

If demos A + B run end-to-end without hand-holding, v0.3's spine is
done. Demo C is ceremony — should pass trivially given the freeze
mechanic.

-----

## 15. Open questions

1. **Skill manifest file.** Today, audit-skill discovery is by
   listing the `.factory/audits/` directory. v0.4's marinate
   scheduler will want per-skill cron config. Should we ship
   `.factory/audits.yaml` now (carrying just `report_path` override
   for v0.3) so v0.4 has a place to extend? Lean: yes — empty file
   on first install, becomes load-bearing in v0.4.
2. **Multi-finding promotion atomicity.** When the operator selects
   5 findings and the bridge recommends "plan" but they want "bug,"
   we create one task with all 5 findings as the body? Or 5
   separate tasks? Lean: one task; bug capture is "remember this
   thing," not "track each thing." Operator can split later.
3. **Audit cancellation.** A long-running exec audit (e.g.,
   `code-review` on a large diff) — operator wants to abort. v0.1
   has run abort; v0.3 audits inherit the same primitive, but the
   ergonomics around "abort during exec, audit row stuck in
   `running`" need a cleanup pass. Lean: status `failed` with
   reason `aborted_by_operator`; same as run abort.
4. **Bridge invocation cost.** `promoteFindings` fires one claude
   call per promote action. Is that too eager? Operators might
   click promote-then-cancel. Lean: yes, fire eagerly; the modal
   shows the recommendation and a draft, and the operator can
   override or cancel. The cost of a 60s claude call is acceptable
   for the workflow. If costly in practice, add a "preview"
   intermediate step in v0.3.5.
5. **Approved-report linking.** When the agent reads CLAUDE.md and
   CLAUDE.md says "see `docs/internal/audits/`," it pulls in the
   *most recent* audit, but old approved reports may be stale (the
   project has moved on). Lean: the docs-audit skill itself flags
   stale audit references in CLAUDE.md as findings. Self-correcting.
6. **VISION.md authoring without a triage decision.** Today
   `project_spec` plans are decision-rooted. `project_vision` plans
   on existing projects have no decision. Schema accommodates
   (`decision_id` already nullable). Worth confirming the inbox
   render works for decision-less plans — should already be a
   no-op since v0.2.
7. **Tier downgrade.** Operator changes tier from `personal` →
   `tinker`. Existing VISION.md stays, default audits stay, but no
   new freeze-precondition enforcement. Lean: this is fine —
   downgrading is reversible, and the artifacts retain value
   regardless of tier.
8. **Audit running while a code-changing run is active.** Concurrency
   already handles this (worker pool default 4); audits get a slot
   like runs. Should there be a separate audit pool? Lean: no —
   one pool keeps capacity-planning simple. If audits saturate the
   pool, that's a v0.4 marinate-scheduler problem.

-----

## 16. What v0.3 does **not** answer (carry to v0.4)

- **Marinate scheduler.** Audits run on-demand in v0.3; cadence is
  v0.4. The audit primitive is shaped to be schedulable.
- **Audits as merge gates.** v0.3 audits are advisory. Selected
  audit kinds becoming blocking is v0.4 once finding severity has
  proven reliable.
- **Push notifications.** Inbox surfacing for `audit_completed` is
  in-app only. Native push is v0.4 ergonomics.
- **In-app prompt editor (Monaco).** v0.2 added a read-only prompts
  viewer. Editing them in-app is still v0.4+.
- **Cross-project audit history.** "This finding shows up in 3
  projects" pattern detection is v0.5 cross-project memory.
- **AI-authored audit skills.** v0.3 ships templates the operator
  customizes. Auto-generation of skills from project context is
  v0.5+ if it earns its keep.
- **Tier promotion gates** (the spec.md §13 v0.3 mechanic — first PR,
  day-7, first-user checkpoints). Tier in v0.3 is operator-edited;
  *gated* promotion is v0.4+.
- **Multi-provider agent backend** (Codex, Gemini). No second-instance
  pull yet. v0.4+ if a real second instance arrives.

These remain on the `docs/vision.md` §6.3 slate.
