# ADR-003 · Audit primitive — read-mostly agent invocations that produce reports

**Status:** proposed (2026-05-04)
**Scope:** v0.3
**Supersedes / refines:** ADR-002 (the Plan primitive substrate is reused
for plan-shaped consumers; audits sit alongside plans, not inside them).

## Context

v0.1 ships the spine: idea → triage → bootstrap → run. v0.2 adds the
Plan primitive: structured agent collaboration around planning artifacts
(project_spec, task_plan, refinement). Both v0.1 and v0.2 optimize for
"produce code change → merge to main." Living with v0.2 surfaced two
related signals:

- **Long-lived projects need recurring quality surfaces, not just
  point-in-time runs.** Forge's `/product`, `/sweep-issues`, `/ux-audit`
  patterns demonstrate that an agent reading a codebase + project
  doctrine and *producing a structured report with severity-graded
  findings* is a distinct kind of work. Findings often spawn many
  small follow-ups; the audit is the parent. Today there is no
  primitive for this.
- **Path B unlock requires alignment artifacts.** A `feature_plan`
  shipping into an existing project must reckon with what the project
  is for (vision), what its current state is (status / merged work),
  and where it is drifting (audits). Without the audit primitive,
  alignment is an unfunded mandate.

Forge's `~/dev/forge/.claude/skills/product/SKILL.md` is the working
prototype: a 4-test "vision filter" (identity / principle / phase /
replacement) gates spec authoring; `/product` produces a vision
integrity check + phase completeness + synergy map + ranked priorities.
Forge's `~/dev/design/.claude/skills/ux-audit/` is the second
working prototype: 10 audit areas, 20KB criteria reference, severity
grades, file-pinned findings, optional fix-mode. Different domains,
same shape.

## Decision

Introduce a first-class **Audit** primitive: a project-scoped agent
invocation that consumes a versioned **audit skill** (a markdown file
in the project's repo) and produces a versioned **audit report** with
zero or more **findings**. Audits have their own lifecycle distinct
from runs and plans:

```
[running] → [completed] → [reviewed] → [approved | rejected]
                                             |
                                             +— approval commits the
                                                report to the repo at
                                                docs/internal/audits/
                                                <date>-<slug>.md
```

Audits are **not runs.** They share agent-invocation infrastructure
(`claude --print` for read-only audits, runtime worktree spawn for
audits that execute project commands), but lifecycle, output shape,
and consumer model differ enough that overloading `runs` would mean
constant special-casing.

Audits are **not plans.** Plans are *thread*-shaped — operator and
agent iterate a draft until freeze. Audits are *report*-shaped — the
agent produces a structured artifact in one (or a few) turn(s) and the
operator reviews findings rather than co-authoring the report itself.

## Shape

### Audit skill (lives in the project repo)

```
<project>/.factory/audits/<name>/
├── SKILL.md              # frontmatter + body, identical convention to forge's .claude/skills/
└── references/           # optional, criteria checklists / templates
    └── <criteria>.md
```

`SKILL.md` frontmatter:

```yaml
---
name: ux-audit
description: "End-to-end UI/UX audit of the dwell platform"
kind: read-only            # read-only | exec
needs_worktree: false      # true if the agent runs project commands
default_severity_grade: enabled  # enabled | disabled
---
```

`kind: read-only` audits run via `claude --print` (no worktree, no
tmux). `kind: exec` audits run via the v0.1 runtime spawn so the
agent can execute the project's lint / typecheck / test / drift-check
commands. Both produce reports; only `exec` audits need `--dangerously-skip-permissions`.

### Audit row (Factory DB)

```typescript
interface Audit {
  id: string;
  projectId: string;
  skillName: string;          // matches the directory name under .factory/audits/
  skillVersion: string;       // git SHA of the skill file at audit-start time
  status: "running" | "completed" | "reviewed" | "approved" | "rejected" | "failed";
  startedAt: number;
  completedAt: number | null;
  reviewedAt: number | null;
  approvedAt: number | null;
  rejectedAt: number | null;
  // Report markdown — populated on completion. Null while running.
  reportMarkdown: string | null;
  // Structured findings extracted from the report. May be null if the
  // skill doesn't emit structured findings (some audits are narrative-only).
  findings: AuditFinding[] | null;
  // Where the report ends up if approved. Repo-relative path.
  approvedReportPath: string | null;
  // Agent invocation refs — session id for resume across operator
  // questions on the report (reuses v0.2's session-resume mechanic).
  claudeSessionId: string | null;
}

interface AuditFinding {
  id: string;                 // cuid2, stable across the report's lifetime
  severity: "critical" | "major" | "minor" | "enhancement";
  title: string;              // <120 char headline
  body: string;               // markdown, can include code refs
  filePath: string | null;    // repo-relative, when applicable
  line: number | null;
  // Set when the operator promotes the finding to a plan or task.
  promotedTo: { kind: "plan"; planId: string } | { kind: "task"; taskId: string } | null;
}
```

Findings live inline on the audit row as JSON. They are **not** their
own table in v0.3 — v0.4 may promote them to a table once promotion
flows mature, but JSON-on-row keeps reads fast (one query loads the
whole report) and matches v0.2's `quality_report` precedent.

### Lifecycle

`running` → agent invocation in progress. The pane streams (xterm for
exec audits, plain text for read-only).

`completed` → agent emitted a `factory-status: done` declaration AND
a parseable report. The contract is the same as v0.2 plan iteration:
null parse → `failed`, never silently completed. Findings are
extracted from a fenced JSON block in the report (per the audit
skill's prompt template).

`reviewed` → operator opened the audit and looked at it. Optional UX
state — distinguishes "report ready, hasn't been seen" from "operator
saw it, hasn't acted." Used for inbox surfacing.

`approved` → operator accepts the report as project doctrine. The
report markdown is committed to the project repo at
`docs/internal/audits/<YYYY-MM-DD>-<skillName>.md` (default;
operator-configurable in `<project>/.factory/audits.yaml`). The
audit row stays as a fast index but the file is canonical.

`rejected` → operator decides this audit run produced a bad report
(false positives, hallucinations, wrong area). The row stays for
audit trail; nothing is committed to the repo.

`failed` → agent invocation failed or report didn't parse. Same
honesty contract as v0.1 runs and v0.2 plans.

## Consumer model

Audits have three operator-facing surfaces:

### 1. Audit pane (live & post-completion)

Mirrors the v0.1 live pane shape. While `running`, raw bytes stream
to the operator. After `completed`, the report markdown renders with
findings rendered as severity-graded cards.

### 2. Findings → action

The new flow specified in `docs/spec-v0.3.md` §[Findings flow]:

```
[audit report]
  └── operator selects 1..N findings
       └── one Claude invocation evaluates tractable path forward
            ├── recommends "create a plan"
            │     └── drafts a task_plan or feature_plan from the findings
            │         operator iterates as v0.2
            │
            └── recommends "create a bug"
                  └── creates a minimal task (title + body, label
                      `bug` + `needs-refinement`)
                      operator returns later to refine via the existing
                      `refinement` plan flow
```

The "evaluator" invocation is one short claude call (no resume needed)
that takes (findings, project context) and returns a recommendation +
draft. The operator can override the recommendation. This invocation
is *not* itself an audit — it's a small bridge.

The "create a bug" path creates a task directly via `tasks.create`
(new mutation). This is the first time Factory has a task creation
path that doesn't go through a plan freeze. Routing all task
creation through `apps/daemon/src/projects/tasks.ts` (currently does
read + update; v0.3 adds write) keeps the storage seam single-pointed
for a future swap to GitHub Issues or beads.

### 3. Approved report consumption

Approved reports live at `docs/internal/audits/<date>-<slug>.md`. They
are referenced from `CLAUDE.md` (the agent's reading list) — runs
follow the reference and read prior audit findings as context. There
is **no** auto-prepending of audit content to run prompts. The agent
loads what CLAUDE.md tells it to load.

## Integration points

- **`packages/db/src/schema.ts`** — new `audits` table. No changes to
  `plans`, `runs`, or `tasks` for the audit primitive itself.
- **`apps/daemon/src/audits/`** — new module mirroring
  `apps/daemon/src/plans/`: `iterate.ts` (run-an-audit-skill),
  `findings.ts` (extract findings from report), `promote.ts` (the
  bridge invocation that turns selected findings into a plan or
  bug), `report-commit.ts` (writes approved report to repo).
- **`apps/daemon/src/routers/audits.ts`** — new tRPC router:
  `list`, `get`, `submit`, `approve`, `reject`, `promoteFindings`.
- **`apps/daemon/src/projects/tasks.ts`** — adds `createTask`
  function consuming the existing parse/render helpers. Refactors
  `bootstrap.ts` and `plans/refine.ts` to use it (clean refactor,
  one-file scope).
- **`apps/daemon/src/projects/audit-skills.ts`** — new helper:
  `listSkills(projectPath)`, `readSkill(projectPath, name)`. One
  function per operation; future remote-skill-registry is a provider
  swap.
- **PWA** — new `/projects/:id/audits` route, audit pane rendering,
  finding-promotion flow. Inbox surfaces `completed` audits as a new
  card kind.
- **CLAUDE.md (factory's)** — new architectural contract: "Audits are
  read-mostly; they never auto-merge code, they produce reports.
  Approved reports get committed to the project repo, not stored only
  in Factory state."

## Default audit skills (templates Factory ships)

Factory ships **template** skills as docs (`docs/audit-skill-templates/`)
that the operator copies into a project's `.factory/audits/`. Factory
does **not** auto-install audits into a project — that is a
project-deepening-flow operator action.

Templates shipped in v0.3:

| Template | kind | Default severity | Purpose |
|----------|------|------------------|---------|
| `code-review` | exec | enabled | Read recent diffs, surface logic / security / convention findings |
| `docs-audit` | read-only | enabled | Vision/CLAUDE.md/README coherence; outdated references |
| `task-sweep` | read-only | enabled | Score tasks against quality checklist; flag `needs-refinement` |
| `drift-check` | read-only | enabled | Compare last run's actual touches against `task_plan.touches` |

Each template is operator-customizable per project after copy.

## Why a separate primitive (instead of `runKind: 'audit'` overlay)

Considered. Rejected on three grounds:

1. **Lifecycle differs structurally.** Runs go `queued → running →
   completed | failed | blocked` and merge on `completed`. Audits go
   `running → completed → reviewed → approved | rejected` and *commit
   to repo* on `approved`. Forcing both into one state machine means
   either lying about what `completed` means or maintaining a parallel
   `runKind` switch in every state-change consumer.
2. **Output shape differs.** Runs produce git commits + a `quality_report`.
   Audits produce a markdown report + a structured `findings` array.
   The runs table either gains audit-only columns (`reportMarkdown`,
   `findings`, `approvedReportPath`) that are null for 95% of rows, or
   the audit fields hide behind discriminated-union JSON parsing on
   every read.
3. **PWA surfaces want different verbs.** A run shows a tmux pane and
   a commit list. An audit shows a markdown report and a
   severity-graded findings list with promotion actions. Sharing a
   single `LivePane` route means a giant `if (runKind === 'audit')`
   that grows with every audit feature.

The cost of a separate primitive is one new table, one new router,
one new PWA route family. The cost of the overlay is paid on every
state change, every read, every UI render forever.

## Path-A / Path-B duality (from ADR-002, applied to audits)

Audits are kind-agnostic about path. A Path A project (just bootstrapped
from an idea) and a Path B project (long-lived, shipping features)
both run audits the same way. Tier matters more than path:

- **Tinker**: audits opt-in, no defaults installed.
- **Personal**: docs-audit + task-sweep installed by deepening flow.
- **Share / productize**: full default set, vision-integrity audit added.

This mirrors v0.3's tier-aware onboarding in `project_vision`.

## What stays out of v0.3

- **Audit scheduling.** v0.3 audits are on-demand. v0.4's marinate
  scheduler hosts cadence (weekly drift-check, monthly vision-integrity).
  The audit primitive is shaped to be schedulable; the scheduler
  itself ships later.
- **Audits as merge gates.** v0.3 audits are advisory. v0.4 makes
  selected audit kinds blocking on merge for projects that opt in.
- **Cross-project audit history.** v0.3 audits are scoped to one
  project. Cross-project patterns (the same finding showing up in 5
  projects → "this is a Factory-level concern") is v0.5 cross-project
  memory territory.
- **Findings as their own table.** Stays inline JSON on the audit row.
  Promote to a table when finding-promotion flows actually need
  per-finding querying.
- **AI-authored audit skills.** Operator authors skills with agent
  help (via a guided plan or just a good template), but Factory does
  not auto-generate skills. Skill quality is operator-curated.

## Open questions

1. **Skill discovery.** Today, the runtime knows about audit skills
   by listing `<project>/.factory/audits/`. Should `audits.yaml`
   exist in the project root to make the inventory explicit (and to
   carry per-skill config like cron schedules in v0.4)? Lean: not
   yet — the directory listing is canonical, and a manifest file
   becomes load-bearing if cadence ships. v0.4 work.
2. **Severity grading authority.** The skill prompt asks the agent
   to grade findings. Should there be a global rubric (`severity
   means X`) or per-skill rubric (`severity in this audit's domain
   means Y`)? Lean: per-skill, since UX-major and security-major are
   not the same kind of major. The skill's prompt body defines the
   rubric in plain English.
3. **Approved-report immutability.** Once committed to repo, an
   approved audit report is a regular file the operator can edit.
   The Factory row's `reportMarkdown` becomes stale. Lean: that's
   fine — the repo is canonical. The Factory row stays as-of-approval
   for audit trail. Re-running the audit produces a new row + new
   committed report.
4. **Failed audit retention.** A failed audit (agent did not produce
   a parseable report) should not be retried automatically. Operator
   decides. Lean: keep the failed row visible for one week (so the
   operator can see what went wrong), then auto-archive to a
   collapsed list. Same posture as failed plans.
5. **Audit skills as runs of themselves.** A `docs-audit` could
   itself be audited ("is the docs-audit catching the right things?").
   v0.3 doesn't pursue this — meta-audits are a distraction. v0.5+
   if rubric self-iteration earns its keep.
