# Factory v0.4 — Specification

> **Scope:** v0.4 only — the changes layered on top of v0.1 + v0.2 + v0.3.
> **Companion docs:** `docs/spec.md` (v0.1, frozen), `docs/spec-v0.2.md`
> (v0.2, frozen), `docs/spec-v0.3.md` (v0.3, frozen),
> `docs/vision.md` (post-v0.1 direction),
> `docs/adr/004-audit-cadence.md` (the architectural commit this spec
> implements), `CLAUDE.md` (architectural contracts).
>
> Read `docs/spec.md`, `docs/spec-v0.2.md`, and `docs/spec-v0.3.md`
> once first if you have not. This document does not repeat earlier
> data models, runtime, or PWA conventions; it specifies only the
> v0.4 deltas.

-----

## 1. Theme & one-paragraph thesis

v0.3 made audits possible. v0.4 makes them **automatic-but-still-honest**.
A project that has installed `docs-audit` and `drift-check` should
have a recurring-cadence flow: weekly docs coherence checks, on-merge
drift checks, all surfacing as inbox cards the operator triages on
their own time. The audit primitive is unchanged; v0.4 adds a thin
schedule layer that calls `audits.submit` programmatically when a
schedule is due. Operator opt-in is one click on install (templates
declare a suggested cadence). Schedules never auto-approve, auto-promote,
or auto-merge — Factory remains a tool, not a gatekeeper, and the
operator is still the only path to a repo write.

-----

## 2. Goals & Non-Goals

### 2.1 Goals (v0.4)

- An **audit schedule** primitive: (project, skill, cadence, enabled)
  rows that, when due, programmatically call `audits.submit`. Schedules
  live alongside the audit primitive, not inside it.
- A small fixed **cadence vocabulary**: `daily`, `weekly`, `monthly`,
  `on_merge`, `on_freeze`. Stored as strings on the schedule row.
- Audit skill `SKILL.md` frontmatter learns an optional
  `suggested_cadence` field. Factory's four shipped templates pick up
  sensible defaults (see ADR-004).
- The install flow gets a one-click "schedule on suggested cadence?"
  toggle, defaulting ON when the frontmatter declares one.
- A daemon-side **scheduler worker**: 60s tick for time-based schedules,
  EventBus subscriber for `on_merge` / `on_freeze`.
- The audits section grows inline schedule annotations + enable/disable
  + cadence-edit per installed skill.
- Audit cards gain an `auto` chip when produced by a schedule, so the
  operator can distinguish operator-triggered from scheduler-triggered.
- Two new daemon events — `run_merged`, `plan_frozen` — to drive
  event-based schedules. Existing emit sites add the publish calls.

### 2.2 Non-Goals (v0.4)

- Custom cron expressions / calendar-anchored cadences. Five-string
  vocabulary only. Real demand for "every Monday 08:00" can lift this
  in v0.5+.
- Multiple schedules per (project, skill). Unique constraint enforced.
- Audits as merge gates. Still v0.5+ — depends on severity-signal
  reliability that more audit volume (which v0.4 produces) will surface.
- Cross-project schedules. Each project owns its own schedules.
- Push notifications. Inbox surfaces scheduled-audit completion the
  same way it surfaces any other audit completion.
- Auto-disable on failure streaks. Surface failures in the schedule
  row, but the operator decides whether to disable.
- Code-changing scheduled actions. All scheduled work is read-mostly
  audits. Schedules **never** trigger code-changing runs. (Hard line —
  see ADR-004 §"What stays out of v0.4".)
- Findings as their own DB table. Still inline JSON on the audit row,
  per v0.3.
- AI-authored audit skills or AI-suggested cadence values. Operators
  choose cadences from the fixed vocabulary.

-----

## 3. Architecture deltas

### 3.1 New module: `apps/daemon/src/audits/schedule.ts`

Single source of truth for schedule operations. Pure data-access +
small policy (compute next_run_at, decide whether to skip a tick).
The router and the scheduler worker both consume it. No I/O beyond
the database and an injected `now()`.

```typescript
export async function listSchedules(
  db: Db,
  projectId: string,
): Promise<AuditScheduleRow[]>;

export async function upsertSchedule(
  db: Db,
  input: { projectId: string; skillName: string; cadence: AuditCadence; enabled: boolean },
): Promise<AuditScheduleRow>;

export async function setEnabled(
  db: Db,
  scheduleId: string,
  enabled: boolean,
): Promise<AuditScheduleRow>;

export async function setCadence(
  db: Db,
  scheduleId: string,
  cadence: AuditCadence,
  now?: number,
): Promise<AuditScheduleRow>;

/** Time-based tick. Returns the schedules that should fire now. */
export async function pickDueSchedules(
  db: Db,
  now?: number,
): Promise<AuditScheduleRow[]>;

/** Event-based dispatch. Returns matching schedules. */
export async function pickEventSchedules(
  db: Db,
  event: "on_merge" | "on_freeze",
  projectId: string,
): Promise<AuditScheduleRow[]>;

/** Records the audit that a schedule produced and recomputes next_run_at. */
export async function markFired(
  db: Db,
  scheduleId: string,
  auditId: string,
  now?: number,
): Promise<void>;
```

### 3.2 New worker: `apps/daemon/src/workers/scheduler.ts`

Started from `apps/daemon/src/index.ts` after the worker pool. One
process-wide instance.

```typescript
export interface SchedulerDeps {
  db: Db;
  events: EventBus;
  config: FactoryConfig;
  /** Submits a scheduled audit through the same path operator-triggered audits use. */
  submitAudit: (input: { projectId: string; skillName: string; triggeredBy: "schedule"; scheduleId: string }) => Promise<{ auditId: string }>;
  now?: () => number;
}

export function startScheduler(deps: SchedulerDeps): { stop: () => void };
```

Internals:

1. **Time tick** every 60 000 ms:
   - `pickDueSchedules(db, now)` → for each due schedule, check whether
     a prior `audits.submit` for the same `(projectId, skillName)` is
     still `running`; if so, log "skipped — prior run in progress"
     and continue (do **not** bump `next_run_at`).
   - Otherwise call `submitAudit({ ..., triggeredBy: "schedule" })`,
     `markFired(scheduleId, auditId)` to set `last_run_at`,
     `last_audit_id`, and recompute `next_run_at`.
2. **Event subscription** on the EventBus: kinds `run_merged` and
   `plan_frozen`. For each event, `pickEventSchedules(...)` and
   `submitAudit(...)` for each match. Same skip-if-running guard.

The scheduler does not attempt to backfill missed ticks (see ADR-004
§"Catch-up policy"). On daemon startup, schedules whose
`next_run_at` is in the past are treated as "due now" — they fire
once, then the next interval is computed from `now`.

### 3.3 Extended: `apps/daemon/src/audits/templates.ts`

The frontmatter parser already accepts unknown fields. v0.4 adds an
explicit optional `suggested_cadence` field to the
`AuditSkillFrontmatter` type and the parser. The install flow reads
it to default the schedule toggle.

### 3.4 Extended: `apps/daemon/src/events.ts`

Two new event kinds on the `inbox` channel:

```typescript
| { channel: "inbox"; kind: "run_merged"; runId: string; projectId: string }
| { channel: "inbox"; kind: "plan_frozen"; planId: string; projectId: string; planKind: PlanKind }
```

Emit sites:

- `apps/daemon/src/workers/runner.ts` — after `mergeIntoMain` returns
  success, before resolving the run record.
- `apps/daemon/src/routers/plans.ts` — inside the `freeze` mutation,
  after the status transition is persisted.

### 3.5 Submit path: `triggeredBy` propagation

`audits.submit` (existing in v0.3) gains an optional `triggeredBy`
input field:

```typescript
.input(z.object({
  projectId: z.string(),
  skillName: z.string().min(1).max(100),
  // v0.4 addition
  triggeredBy: z.enum(["operator", "schedule"]).optional().default("operator"),
  scheduleId: z.string().optional(),
}))
```

The audit row gains `triggeredBy` and `scheduleId` columns (see §4
data model). The PWA uses `triggeredBy` to render the `auto` chip.

-----

## 4. Data model deltas

### 4.1 New table: `audit_schedules`

```typescript
export const auditCadenceEnum = [
  "daily",
  "weekly",
  "monthly",
  "on_merge",
  "on_freeze",
] as const;
export type AuditCadence = (typeof auditCadenceEnum)[number];

export const auditSchedules = sqliteTable(
  "audit_schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .references(() => projects.id)
      .notNull(),
    skillName: text("skill_name").notNull(),
    cadence: text("cadence", { enum: auditCadenceEnum }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** For time-based: when the next tick should fire. For event-based: null. */
    nextRunAt: integer("next_run_at"),
    lastRunAt: integer("last_run_at"),
    /** The audit row id produced by the most recent fire. */
    lastAuditId: text("last_audit_id"),
  },
  (t) => [
    uniqueIndex("audit_schedules_project_skill_idx").on(t.projectId, t.skillName),
    index("audit_schedules_due_idx").on(t.enabled, t.nextRunAt),
    index("audit_schedules_event_idx").on(t.enabled, t.cadence),
  ],
);

export type AuditScheduleRow = typeof auditSchedules.$inferSelect;
export type NewAuditScheduleRow = typeof auditSchedules.$inferInsert;
```

### 4.2 Extended: `audits` table

Two new columns:

```typescript
// added to the existing audits table
triggeredBy: text("triggered_by", { enum: ["operator", "schedule"] }).notNull().default("operator"),
scheduleId: text("schedule_id").references(() => auditSchedules.id),
```

Pre-v0.4 audit rows backfill `triggeredBy = 'operator'`,
`scheduleId = null`.

### 4.3 Extended: `audit_skill_frontmatter` (TS type, no DB change)

```typescript
export interface AuditSkillFrontmatter {
  name: string;
  description: string;
  kind: AuditSkillKind;
  needsWorktree: boolean;
  defaultSeverityGrade: "enabled" | "disabled";
  // v0.4
  suggestedCadence?: AuditCadence;
}
```

### 4.4 Migration 0009

Generated by `bun run db:generate`. Three statements:

1. `CREATE TABLE audit_schedules ...`
2. `ALTER TABLE audits ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'operator'`
3. `ALTER TABLE audits ADD COLUMN schedule_id TEXT REFERENCES audit_schedules(id)`

-----

## 5. API — tRPC routes

All under the existing `audits` router unless noted.

### 5.1 `audits.installTemplate` — extended

```typescript
.input(z.object({
  projectId: z.string(),
  templateName: z.string().min(1).max(60),
  // v0.4 addition: when present, also creates an audit_schedules row
  // in the same transaction.
  cadence: z.enum(auditCadenceEnum).optional(),
  enabled: z.boolean().optional().default(true),
}))
```

When `cadence` is omitted, behavior is identical to v0.3 (file copy +
commit only). When present, an `audit_schedules` row is upserted in
the same logical operation. The PWA passes the operator's choice from
the install confirmation.

### 5.2 `audits.listSchedules`

```typescript
.input(z.object({ projectId: z.string() }))
.query(...): Promise<AuditScheduleRow[]>
```

Returns every schedule for the project, ordered by `skillName`.

### 5.3 `audits.upsertSchedule`

```typescript
.input(z.object({
  projectId: z.string(),
  skillName: z.string(),
  cadence: z.enum(auditCadenceEnum),
  enabled: z.boolean().optional().default(true),
}))
.mutation(...): Promise<AuditScheduleRow>
```

Idempotent on `(projectId, skillName)`. Used both by the install flow
(when scheduling at install time) and by the audits-section "schedule
this skill" UI for skills that were installed without a schedule.

### 5.4 `audits.setScheduleEnabled`

```typescript
.input(z.object({ scheduleId: z.string(), enabled: z.boolean() }))
.mutation(...): Promise<AuditScheduleRow>
```

The pause / resume control. Setting `enabled = false` keeps the row
(so cadence is preserved); setting `true` recomputes `next_run_at`
from `now` for time-based schedules.

### 5.5 `audits.setScheduleCadence`

```typescript
.input(z.object({ scheduleId: z.string(), cadence: z.enum(auditCadenceEnum) }))
.mutation(...): Promise<AuditScheduleRow>
```

Recomputes `next_run_at` from `now` (open question 4 in ADR-004 —
this spec commits to "from now" for less surprise).

### 5.6 `audits.deleteSchedule`

```typescript
.input(z.object({ scheduleId: z.string() }))
.mutation(...): Promise<{ ok: true }>
```

Hard delete. The operator may want to remove a schedule entirely
(e.g., after uninstalling the skill). Audit rows produced by the
schedule keep their `scheduleId` column populated as a tombstone
reference; foreign-key is `ON DELETE SET NULL` to avoid cascading
deletion of historical audits.

### 5.7 `audits.submit` — extended

See §3.5. Adds optional `triggeredBy` + `scheduleId` inputs. The
scheduler worker passes `"schedule"` and the schedule id; operator-
triggered submissions omit both (defaults to `"operator"`).

-----

## 6. Runtime deltas

### 6.1 Cadence semantics

```typescript
const INTERVAL_MS: Record<AuditCadence, number | null> = {
  daily:    24 * 60 * 60 * 1000,
  weekly:    7 * 24 * 60 * 60 * 1000,
  monthly:  30 * 24 * 60 * 60 * 1000, // intentionally 30d, not calendar months
  on_merge:  null,                     // event-driven
  on_freeze: null,                     // event-driven
};

export function computeNextRunAt(cadence: AuditCadence, from: number): number | null {
  const ms = INTERVAL_MS[cadence];
  return ms === null ? null : from + ms;
}
```

### 6.2 Scheduler tick (60s)

```typescript
async function tick(deps: SchedulerDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const due = await pickDueSchedules(deps.db, now);
  for (const s of due) {
    const inflight = await isInflight(deps.db, s.projectId, s.skillName);
    if (inflight) {
      console.log(`[scheduler] skip ${s.id} — prior audit running`);
      continue;
    }
    try {
      const { auditId } = await deps.submitAudit({
        projectId: s.projectId,
        skillName: s.skillName,
        triggeredBy: "schedule",
        scheduleId: s.id,
      });
      await markFired(deps.db, s.id, auditId, now);
    } catch (err) {
      console.warn(`[scheduler] submit failed for ${s.id}: ${err}`);
      // Bump next_run_at anyway so we don't pile up retries every
      // minute. Operator sees the failure on the audit row that did
      // fire (or the absence of one).
      await markFired(deps.db, s.id, /* auditId */ "", now);
    }
  }
}
```

### 6.3 Event subscription

```typescript
deps.events.subscribe((e) => {
  if (e.channel !== "inbox") return;
  if (e.kind === "run_merged") {
    void dispatchEvent(deps, "on_merge", e.projectId);
  } else if (e.kind === "plan_frozen") {
    void dispatchEvent(deps, "on_freeze", e.projectId);
  }
});

async function dispatchEvent(
  deps: SchedulerDeps,
  cadence: "on_merge" | "on_freeze",
  projectId: string,
): Promise<void> {
  const matches = await pickEventSchedules(deps.db, cadence, projectId);
  for (const s of matches) {
    const inflight = await isInflight(deps.db, s.projectId, s.skillName);
    if (inflight) continue;
    const { auditId } = await deps.submitAudit({
      projectId: s.projectId,
      skillName: s.skillName,
      triggeredBy: "schedule",
      scheduleId: s.id,
    });
    await markFired(deps.db, s.id, auditId, Date.now());
  }
}
```

### 6.4 In-flight check

```typescript
async function isInflight(db: Db, projectId: string, skillName: string): Promise<boolean> {
  const row = await db
    .select({ id: schema.audits.id })
    .from(schema.audits)
    .where(
      and(
        eq(schema.audits.projectId, projectId),
        eq(schema.audits.skillName, skillName),
        eq(schema.audits.status, "running"),
      ),
    )
    .get();
  return row != null;
}
```

-----

## 7. PWA — new screens & UX

### 7.1 Install confirmation (extended)

The existing `audits-section.tsx` install flow gains a confirmation
step when the template's frontmatter declares `suggested_cadence`:

```
┌─ install docs-audit ──────────────────────────────────┐
│  schedule on suggested cadence?                        │
│   ◉  weekly  (the template's suggested cadence)        │
│   ○  daily                                             │
│   ○  monthly                                           │
│   ○  on_merge                                          │
│   ○  on_freeze                                         │
│   ○  never (run manually)                              │
│                                                        │
│   [install]  [cancel]                                  │
└────────────────────────────────────────────────────────┘
```

For templates without `suggested_cadence`, no confirmation step —
revert to v0.3's one-click behavior.

Component: extend the existing install button in `audits-section.tsx`
to open a small popover when needed. No new route.

### 7.2 Audits section (extended)

Each installed skill row grows a second line showing schedule state:

```
docs-audit · read-only · last run 2d ago
   ▷ weekly · enabled · next in 5d            [⏸] [⚙]
```

States:

- **No schedule for this skill**: row shows just a "schedule…" link
  that opens the cadence picker.
- **Schedule exists, enabled**: shows cadence + "next in Nd" (time-
  based) or "next on next merge" (event-based) + pause / edit
  controls.
- **Schedule exists, disabled**: shows cadence + "paused" + resume
  control.

Components:

- `apps/pwa/src/components/audit-schedule-row.tsx` (new) — renders
  the cadence chip + controls. Embedded inside `audits-section.tsx`.
- `apps/pwa/src/components/cadence-picker.tsx` (new) — the inline
  dropdown for cadence values. Used in install confirmation and in
  the audits section.

### 7.3 Audit card — `auto` chip

`apps/pwa/src/components/audit-card.tsx` adds a small `auto` chip
when `audit.triggeredBy === "schedule"`:

```
┌─ audit · docs-audit ─ completed ─ auto ─ 3M 1m  ─ 2h ago ─┐
│  weekly drift check on this project                       │
│  3 findings — tap to review and promote.                  │
└────────────────────────────────────────────────────────────┘
```

The chip is informational. The card behavior is identical to a
v0.3 audit card.

### 7.4 No new top-level routes

All v0.4 surfaces fit inside the existing `audits-section.tsx` on
project-detail. No `/projects/:id/schedules` route. The audits
section is already the single attention sink for everything
audit-shaped (per CLAUDE.md "the inbox is the only attention sink"
discipline applied to per-project audit affordances).

-----

## 8. Audit-skill template updates

Each shipped template adds `suggested_cadence` to its frontmatter:

| Template      | New frontmatter line     |
| ------------- | ------------------------ |
| `docs-audit`  | `suggested_cadence: weekly` |
| `task-sweep`  | `suggested_cadence: weekly` |
| `drift-check` | `suggested_cadence: on_merge` |
| `code-review` | `suggested_cadence: on_merge` |

Operator-installed projects that already have these skills (from v0.3)
keep their existing SKILL.md unchanged — Factory does not retroactively
edit operator-customized files. The operator can:

- Re-install the template (which now installs with cadence).
- Hand-edit the SKILL.md frontmatter to add `suggested_cadence`.
- Manually create a schedule via the audits-section UI.

The third option is the most operator-friendly; the install path
becomes the recommended flow for fresh projects, and the manual
schedule-creation flow handles existing projects without operator
churn.

-----

## 9. Operating contract delta

A new architectural-contract bullet for `CLAUDE.md`:

> **Schedules trigger audits; they never approve, promote, or merge.**
> The `audit_schedules` primitive exists upstream of the audit primitive
> (which is upstream of the run primitive). When a schedule fires, it
> calls `audits.submit` exactly the way an operator click would. The
> operator is still the only path to `audits.approve`, finding
> promotion, or any code-changing run. The cadence layer eliminates
> "remember to run" lag; it never weakens the operator-only-write
> guarantee.

Add to the existing v0.3 audit-related contracts in CLAUDE.md.

-----

## 10. Migration & backwards compatibility

- Migration 0009 creates `audit_schedules` and adds two columns to
  `audits` with defaults. Existing audit rows backfill cleanly.
- Pre-v0.4 audit-skill SKILL.md files without `suggested_cadence`
  parse identically to v0.3 — the field is optional.
- The scheduler worker is started from `index.ts`. If the daemon is
  rolled back to v0.3, the worker doesn't run; schedules in the DB are
  ignored (harmless), and `audits.submit` continues to accept calls
  without the new `triggeredBy` field (defaults to `"operator"`).
- The PWA gracefully handles missing `triggeredBy` (treat absence as
  `"operator"`) so a v0.4 PWA can talk to a v0.3 daemon during a
  rolling upgrade.

-----

## 11. Repo layout — new files

```
apps/daemon/src/
  audits/
    schedule.ts              (NEW — schedule data-access + policy)
  workers/
    scheduler.ts             (NEW — 60s tick + event subscriber)

apps/pwa/src/
  components/
    audit-schedule-row.tsx   (NEW — schedule annotation in audits-section)
    cadence-picker.tsx       (NEW — inline cadence dropdown)

packages/db/src/migrations/
  0009_audit_schedules.sql   (NEW — generated)
  meta/0009_snapshot.json    (NEW — generated)

docs/
  spec-v0.4.md               (this file)
  adr/004-audit-cadence.md   (the ADR)
  audit-skill-templates/
    code-review/SKILL.md     (UPDATED — adds suggested_cadence)
    docs-audit/SKILL.md      (UPDATED)
    drift-check/SKILL.md     (UPDATED)
    task-sweep/SKILL.md      (UPDATED)
```

Modified files (non-trivial):

```
packages/db/src/schema.ts                       (+audit_schedules table, +2 cols on audits)
apps/daemon/src/index.ts                        (+startScheduler call)
apps/daemon/src/events.ts                       (+run_merged, +plan_frozen kinds)
apps/daemon/src/workers/runner.ts               (+publish run_merged after merge)
apps/daemon/src/routers/plans.ts                (+publish plan_frozen on freeze)
apps/daemon/src/routers/audits.ts               (+5 schedule procedures, +submit triggeredBy)
apps/daemon/src/audits/templates.ts             (+suggested_cadence parse)
apps/daemon/src/projects/audit-skills.ts        (+suggested_cadence in frontmatter type)
apps/pwa/src/components/audits-section.tsx     (+schedule rows, +install confirmation)
apps/pwa/src/components/audit-card.tsx          (+auto chip)
CLAUDE.md                                       (+schedule contract bullet)
```

-----

## 12. Implementation order (suggested)

A deliberate order so each commit is independently buildable and testable.

1. **Schema + migration 0009.** `audit_schedules` table + two new
   columns on `audits`. Generate migration, rename, apply locally.
2. **Frontmatter parsing.** Add `suggested_cadence` to the
   `AuditSkillFrontmatter` type and the parser in
   `apps/daemon/src/projects/audit-skills.ts`. Update the four shipped
   templates' frontmatter.
3. **Schedule module.** `apps/daemon/src/audits/schedule.ts` —
   `listSchedules`, `upsertSchedule`, `setEnabled`, `setCadence`,
   `pickDueSchedules`, `pickEventSchedules`, `markFired`. Unit-test
   `computeNextRunAt`, `pickDueSchedules`, and the in-flight guard.
4. **tRPC procedures.** Five new procedures + extend `installTemplate`
   and `submit`. Persist `triggeredBy` and `scheduleId` on audit rows.
5. **Daemon events.** Add `run_merged` and `plan_frozen` event kinds;
   wire emit calls in `runner.ts` and `plans.ts`.
6. **Scheduler worker.** `apps/daemon/src/workers/scheduler.ts` — 60s
   tick + event subscription. Started from `apps/daemon/src/index.ts`.
   Integration test: insert a schedule with `next_run_at` in the past,
   tick once, verify the audit is created with `triggeredBy = 'schedule'`.
7. **PWA: install confirmation.** Extend the install button in
   `audits-section.tsx` to open the cadence-picker popover when the
   template declares `suggested_cadence`. Pass the chosen cadence
   through `audits.installTemplate`.
8. **PWA: schedule rows.** Render schedule annotations + controls
   inline on each installed skill row.
9. **PWA: audit-card auto chip.** One-line addition.
10. **CLAUDE.md.** Add the schedule architectural contract.
11. **Smoke test the full loop.** Install `docs-audit` with a daily
    cadence, set `next_run_at` to "now" via the upsert path, watch
    the scheduler fire it, verify the audit lands in the inbox with
    the `auto` chip.

Six well-scoped commits (schema → frontmatter → schedule module →
router + events → scheduler worker → PWA), each independently
revertable.

-----

## 13. What "done" looks like for v0.4

- `bun run typecheck` and `bun run check` pass at every commit.
- `bun test` passes — at least one new integration test for the
  scheduler tick path and one for the event-driven path.
- Installing `docs-audit` in a fresh project produces both a SKILL.md
  in the project repo and an `audit_schedules` row.
- A schedule with `next_run_at` ≤ now triggers an audit within 60
  seconds of daemon startup (or scheduler tick).
- Merging a run successfully into main triggers all `on_merge`
  schedules for that project — verifiable by an audit row with
  `triggeredBy = 'schedule'` appearing within seconds of the merge.
- The audits section on a project with active schedules shows cadence
  + enabled state + next-run estimate per skill.
- The inbox surfaces scheduled-audit completions exactly the way it
  surfaces operator-triggered ones, except for the small `auto` chip
  on the card.
- Disabling a schedule from the PWA stops further fires; re-enabling
  resets `next_run_at` to one cadence interval from now.
- Pre-v0.4 audit rows display correctly (no broken UI from missing
  `triggeredBy` columns — handled by default `"operator"`).

-----

## 14. Open questions

Carried from ADR-004 §"Open questions", repeated here for spec-side
visibility:

- **Skipped-tick visibility**: should the audits-section show "skipped
  — last run still in progress" inline? Default: yes, as a small
  mono note on the schedule row.
- **Cadence change reset semantics**: spec commits to "recompute
  next_run_at from now" (less surprise). Confirm during implementation.
- **Schedule deletion vs disable**: keep both. Disable is the
  reversible everyday action; delete is for "I'm uninstalling this
  skill entirely" — rare, but exposed via a destructive action
  confirmation.
- **`auto` chip color**: dim accent vs neutral mono. Default: neutral
  mono — the chip is informational, not a status flag.

-----

## 15. What v0.4 does **not** answer (carry to v0.5+)

- **Audits-as-merge-gates.** v0.4 raises audit volume; v0.5 can use
  that volume to validate severity-signal reliability, then introduce
  opt-in gating for projects ≥ share/productize tier.
- **Custom cron / calendar cadences.** Five-string vocabulary is
  enough for v0.4; demand for "every Monday" or "weekdays at 08:00"
  unlocks a richer cadence model in v0.5+.
- **Schedule budgets.** Hard caps on cost or invocation count per
  project per day. Runtime metrics (just shipped) make this
  observable; v0.5 can introduce caps when actual cost data warrants.
- **Cross-project schedules.** "Run docs-audit on every personal+
  project" is convenient but premature. Each project still owns its
  schedules.
- **Multiple schedules per (project, skill).** "Daily *and* weekly
  docs-audit" is rejectable as a use case until the operator
  experiences friction.
- **Auto-rotating skills.** "Run a different audit each week from
  this set." Same — premature optimization until the operator asks
  for it.

-----
