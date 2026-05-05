# ADR-004 · Audit cadence — schedules layered on the v0.3 audit primitive

**Status:** proposed (2026-05-04)
**Scope:** v0.4
**Supersedes / refines:** ADR-003 (the audit primitive). v0.3 made
audits possible on-demand; v0.4 adds the schedule layer that the audit
primitive was already shaped to accept (ADR-003 §"What stays out of
v0.3").

## Context

v0.3 ships the audit primitive: an operator clicks "run" on an
installed audit skill, gets back a report with severity-graded findings,
promotes findings to plans or bugs. This works, but it has the same
problem every on-demand surface has: **the operator has to remember to
run it.** A `docs-audit` whose value is "catch CLAUDE.md/VISION.md
drift before it compounds" delivers ~zero of that value if it only fires
when the operator notices something might be drifting — by then the
drift has already compounded.

The signals from v0.3 use:

- The first audit run typically surfaces real findings. The second one,
  three weeks later (when the operator gets around to it), surfaces a
  superset of the same findings *plus* drift that accumulated in
  between. The lag is the value leak.
- Skills with naturally event-anchored value (drift-check after a
  merge, code-review on the diff that just landed) want to fire the
  moment the event happens, not the next time the operator opens the
  audits section.
- Time-anchored skills (docs-audit, task-sweep) want a low-effort
  "once a week, surface what changed" rhythm. The operator's job is
  to triage findings, not to remember the cadence.

vision.md §6.3 named this "marinate scheduler" — fine as a directional
sketch, too cute as a primitive name. v0.4 calls it **audit cadence**.

## Decision

Introduce a thin **audit schedule** primitive layered on the v0.3
audit primitive. A schedule is a (project, skill, cadence, enabled)
tuple that, when due, calls the existing `audits.submit` programmatically.
The audit primitive is unchanged; schedules are upstream of it.

```
[schedule due]
   │
   ▼
[audits.submit]  ── existing v0.3 path ──→  [running] → [completed] → ...
                                                          │
                                                          ▼
                                                    inbox card
                                                    (operator
                                                     reviews on
                                                     their schedule)
```

Schedules **never** auto-approve, auto-promote, or auto-merge anything.
A scheduled audit produces a `completed` audit row exactly the same
shape an on-demand audit would; the operator still does triage. The
cadence layer eliminates the "remember to run" gap, nothing else.

## Shape

### Cadence vocabulary

A small fixed enum, stored as a string on the schedule row. Two
families:

**Time-based** (interval since last run):

- `daily` — 24h
- `weekly` — 7d
- `monthly` — 30d (calendar months are noise; 30d is honest)

**Event-based** (fires on a Factory event):

- `on_merge` — fires when a run successfully merges into main.
- `on_freeze` — fires when a plan transitions to `frozen`.

That's the whole vocabulary in v0.4. Custom cron expressions (`every 3
days`, `weekdays at 08:00`) are deferred to v0.5+ if real demand
surfaces. Calendar-based cadences (`every Monday`) are deferred for the
same reason — interval semantics avoid timezone code and match the
operator's actual mental model ("I want this roughly weekly").

### Suggested cadence (skill frontmatter)

Audit skills declare an optional `suggested_cadence` in their
`SKILL.md` frontmatter. The four shipped templates pick up:

| Skill         | Suggested cadence |
| ------------- | ----------------- |
| `docs-audit`  | `weekly`          |
| `task-sweep`  | `weekly`          |
| `drift-check` | `on_merge`        |
| `code-review` | `on_merge`        |

The frontmatter field is **advisory.** The operator sees it in the
install flow; they can accept (default), change, or skip scheduling
entirely. Skills without `suggested_cadence` install unscheduled —
nothing happens automatically until the operator explicitly schedules
them.

### Schedule row (Factory DB)

```typescript
interface AuditSchedule {
  id: string;
  projectId: string;
  skillName: string;          // matches audits.skillName
  cadence: AuditCadence;      // one of the vocabulary strings
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // For time-based: timestamp when the next tick should fire. For
  // event-based: null (the event itself is the trigger).
  nextRunAt: number | null;
  // Last fired timestamp (null until first run).
  lastRunAt: number | null;
  // Last audit row produced by this schedule (null until first run).
  // Useful for "show me the most recent docs-audit on this project."
  lastAuditId: string | null;
}
```

Unique constraint on `(projectId, skillName)` — one schedule per
project+skill. If the operator wants both daily *and* weekly runs of
the same skill, that's a v0.5+ "multiple schedules" feature; v0.4 keeps
the model trivially auditable.

## Lifecycle

```
[disabled]  ───enable──→  [enabled, due]  ──tick──→  [running audit]
   ▲                          │                          │
   │                          │ event fires              ▼
   └──disable───────  [enabled, idle]  ←──tick complete──┘
                                                          │
                                                  audit row produced;
                                                  inbox surfaces it
                                                  via existing v0.3 path
```

A schedule has no concept of "failed" — failures live on the audit row
it produces. A schedule that's been firing 1-line audits with parse
failures every week is visible in the audits section as 5 weeks of
failed audits; the operator's response is to disable the schedule and
fix the skill, not to debug the schedule itself.

## Trigger model

### Time-based: a single 60s tick

The daemon spins up one `scheduler` worker on startup. Once per minute
it queries `audit_schedules WHERE enabled = true AND next_run_at <= now`,
calls `audits.submit` for each due schedule, and bumps `next_run_at`
by the cadence interval.

60s tick is plenty for daily/weekly/monthly granularity. If a scheduled
audit is still running (last `audits.submit` row for that
project+skill is `running`) the scheduler **skips** the tick — don't
pile up. The next tick will pick it up once the previous run finishes.

### Event-based: subscribe to the existing EventBus

`apps/daemon/src/events.ts` already publishes structured daemon events
(plan freeze, audit completed, etc.). v0.4 adds two more event kinds
that are already implicit:

- `run_merged` — fires from the runner after `mergeIntoMain` succeeds.
- `plan_frozen` — fires from `plans.freeze` (already exists as
  `plan_updated` / status transitions; v0.4 narrows to a dedicated
  `plan_frozen` event so subscribers don't need to re-derive).

The scheduler subscribes to both and submits matching schedules. No
polling, no missed events while the daemon is running.

### Catch-up policy on daemon restart

When the daemon starts and a schedule's `next_run_at` is in the past
(daemon was offline for a week, etc.), the scheduler treats it as "due
now" and submits **one** audit — not seven. Then `next_run_at` gets
bumped forward to the next interval boundary from `now`. No backfill;
the operator doesn't need 7 weekly docs-audits in their inbox.

For event-based schedules: events that fired while the daemon was down
are simply lost. The next merge/freeze fires the next event. This is
correct — Factory is a single-operator tool, not a system of record.

## Operator surface

### Install flow (extended from v0.3)

The existing one-click install (audits section → "available templates"
→ install) gains a small inline confirmation when the template
declares `suggested_cadence`:

```
┌─ install docs-audit ─────────────────┐
│ schedule on suggested cadence?       │
│   ◉ weekly   ○ never (run manually)  │
│   [install]  [cancel]                │
└──────────────────────────────────────┘
```

Default: schedule ON when the frontmatter has a `suggested_cadence`,
OFF when it doesn't. One operator click installs both the skill and
the schedule.

### Audits section (extended)

The audits section on project-detail grows a "scheduled" annotation
on each installed skill row showing cadence + enabled state, with
inline controls:

```
┌─ audits ──────────────────────── 2 skills ─┐
│ docs-audit · read-only · weekly · ENABLED  │
│   last run 2d ago · next in 5d   [⏸] [⚙]  │
│ drift-check · read-only · on_merge · ON    │
│   last run never · next on next merge [⏸]  │
└────────────────────────────────────────────┘
```

`⏸` toggles `enabled`. `⚙` opens an inline cadence picker (the 5
vocabulary strings). No separate route — keeps the audits section as
the single attention sink for everything audit-shaped.

### Inbox

No new inbox surface. A scheduled audit produces a `completed` audit
event exactly like an on-demand audit. The existing v0.3 audit card
shows up in the inbox; operator reviews on their cadence.

The only inbox-side delta is a small `auto` chip on cards from
scheduled audits, so the operator can distinguish "I ran this" from
"the schedule ran this." That's a nudge, not a gate — the action is
the same.

## Integration points

- **`packages/db/src/schema.ts`** — new `audit_schedules` table.
  Migration 0009.
- **`apps/daemon/src/audits/schedule.ts`** (new) — single-source-of-
  truth helpers: `listSchedules`, `upsertSchedule`, `disableSchedule`,
  `tickDueSchedules`, `handleEvent`. Internal-only; the router and
  scheduler worker both consume it.
- **`apps/daemon/src/workers/scheduler.ts`** (new) — 60s tick worker
  + event subscriber. Started from `apps/daemon/src/index.ts` next to
  the worker pool.
- **`apps/daemon/src/routers/audits.ts`** — extends with
  `listSchedules`, `upsertSchedule`, `disableSchedule`,
  `setScheduleCadence`. The existing `installTemplate` mutation gains
  an optional `cadence` input that, when provided, creates the
  schedule row in the same transaction as the file copy.
- **`apps/daemon/src/projects/audit-skills.ts`** — frontmatter parser
  learns the optional `suggested_cadence` field.
- **`apps/daemon/src/events.ts`** — adds `run_merged` and `plan_frozen`
  event kinds; existing publishers gain emit calls.
- **`apps/daemon/src/workers/runner.ts`** — emits `run_merged` after
  `mergeIntoMain` succeeds.
- **`apps/daemon/src/routers/plans.ts`** — emits `plan_frozen` after
  the freeze transition.
- **PWA**:
  - `apps/pwa/src/components/audits-section.tsx` — schedule
    annotations on each installed skill, inline toggle + cadence picker.
  - `apps/pwa/src/components/audit-card.tsx` — "auto" chip when the
    audit's `triggeredBy` indicates a schedule.
- **Default audit skill templates** (`docs/audit-skill-templates/*/SKILL.md`)
  — gain `suggested_cadence` frontmatter values.
- **CLAUDE.md (factory's)** — new architectural contract: "Schedules
  trigger audits; they never auto-approve, auto-promote, or auto-merge.
  The operator is still the only path to repo writes."

## Why a separate primitive (instead of a column on `audits`)

Considered. Rejected on two grounds:

1. **Schedules outlive any one audit.** A `docs-audit` schedule fires
   weekly forever; the audits it produces come and go. Storing the
   schedule on an audit row would require either re-creating the
   schedule on every fire or denormalizing the cadence onto every audit.
2. **Schedules need their own enable/disable state.** "Pause this
   schedule for two weeks while I'm migrating frameworks" is an
   operation on the schedule, not on any specific audit. A column on
   `audits` would conflate "this run was auto" with "future runs are
   on."

The cost of a separate table is one new table, ~5 router methods, one
worker. The cost of overlay-on-audit is paid every time the operator
asks "is this skill scheduled?" forever.

## Path-A / Path-B duality (still applies)

Schedules don't care which path a project came from. A Path A
project (idea → triage → bootstrap) and a Path B project (long-lived,
shipping features into existing repo) schedule audits identically.
Tier matters: tinker projects don't auto-install audits in the first
place, so they don't auto-schedule them either. Personal+ projects
get the deepening flow's installs and (with the v0.4 default) their
suggested cadences enabled by default.

## What stays out of v0.4

- **Custom cron expressions.** Five-string vocabulary only. Operators
  who need "every Monday at 08:00" can wait for v0.5 or run on-demand.
- **Multiple schedules per (project, skill).** Unique constraint
  enforced. v0.5 can lift this if a real use case shows up.
- **Audits as merge gates.** Still v0.4-and-beyond. v0.4's marinate
  scheduler runs *advisory* audits at cadence; gating-on-findings
  is a separate decision still needing severity-signal validation.
- **Push notifications when scheduled audits complete.** v0.4+
  ergonomics. The inbox already surfaces `completed` audits; v0.4
  doesn't add a second notification channel.
- **Cross-project schedules** ("run docs-audit on every personal+
  project"). Each project still maintains its own schedules.
- **Event-based cadences beyond merge/freeze.** No `on_audit_approved`,
  `on_blocked`, etc. Two events covers the obvious cases; we add more
  when something specific surfaces.
- **Schedules that mutate the project.** All scheduled audits are
  read-mostly (read-only or exec-without-commit). A schedule can never
  trigger a code-changing run. That's a hard line.

## Open questions

- **Cadence picker UX**: dropdown vs inline radio vs free-form text
  parsed against the vocabulary? Lean: dropdown. Five values is small
  enough.
- **Skipped-tick visibility**: when the scheduler skips a tick because
  the prior audit is still running, should that be visible to the
  operator (a small "skipped — last run still in progress" line)?
  Probably yes for transparency. Cheap to add.
- **Disable-on-failure auto-policy**: if a scheduled audit fails 3
  times in a row, should the schedule auto-disable? Lean: no, just
  surface the failure streak in the schedule row. Auto-disable hides
  problems; surfacing makes them actionable.
- **Cadence change resets next_run_at?**: if the operator changes
  weekly → daily mid-cycle, does `next_run_at` recompute from now or
  from the last run? Lean: recompute from now (less surprise).
- **`on_freeze` granularity**: fire on every plan freeze, or only
  freezes of `feature_plan` / `task_plan` (excluding e.g.
  `project_vision`)? Lean: every freeze; the audit skill itself
  decides if the report is meaningful.
