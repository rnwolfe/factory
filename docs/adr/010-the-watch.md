# ADR-010 · The Watch — proactive scheduler + ambient & out-of-band work intake

**Status:** proposed (2026-06-27)
**Scope:** the autonomy initiative (WS B in `docs/research/2026-06-27-autonomous-proactive-factory.md`)
**Builds on:** ADR-004 (audit cadence — designed the scheduler shape but **the
`scheduler.ts` tick never shipped**; The Watch builds it). Mirrors the pluggable
registry pattern of `apps/daemon/src/agents/registry.ts`. Refines nothing; adds a
new upstream producer of inbox work.

## Context

Factory is **reactive**. Every unit of work starts from a human action — triage an
idea, freeze a plan, adopt a GitHub issue, click Start. The production data
(`~/.factory-live/data.db`, six weeks) confirms the operator is a steady
~0.6-decisions-per-run interrupt stream, flat as volume tripled: the bottleneck is
judgment, and Factory never *initiates*. Meanwhile the operator runs 5–10 Claude
Code / Codex agents at a time **outside** Factory (115 local project dirs, 960
subagent calls) and hand-rolls proactivity with `/loop` and `/schedule`. Two gaps
fall out:

1. **No cadence, no self-direction.** The v0.4 audit-cadence scheduler was specified
   (ADR-004) but never built — `apps/daemon/src/workers/scheduler.ts` does not exist,
   and the `audits` table has zero production rows. Factory has the two 60s polling
   ticks (`apps/daemon/src/workers/usage-cap.ts`, `apps/daemon/src/inbox-resurface.ts`)
   and an `EventBus` (`apps/daemon/src/events.ts`, already emitting `plan_frozen` /
   `audit_completed` / etc.) — the *shape* of a scheduler, but no scheduler.
2. **Factory is blind to the operator's out-of-band work.** It has no awareness of the
   engineering done in raw Claude Code / Codex sessions — the CLI-building sprints, the
   design-file implementations, the recurring rituals, the corrections. That work is
   recorded locally (`~/.claude/projects/*/*.jsonl`, `~/.codex/`), but Factory never
   reads it, so it can't learn the operator's evolving conventions or notice "you keep
   doing X by hand."

The Watch closes both. It is the reactive→proactive flip, and it is the embodiment of
the **Heimdall** rename: the watchman who sees across all realms, not just his own gate.

**The hard constraint (from the operator, 2026-06-27):** the harnesses Factory observes
must sit behind a **clean pluggable interface**, not hardcoded `claude`/`codex`
branches. Factory already proved this pattern works for agent *dispatch*
(`agents/registry.ts`: "adding a new harness is a single drop-in entry … every consumer
reads from this registry instead of switching on the agent id"). The Watch applies the
same discipline to harness *observation*.

## Decision

Introduce **The Watch**: a single scheduler tick that drives a set of **jobs**. Jobs
produce **observations**; observations surface in the decisions inbox; the operator
promotes them (to tasks, conventions, or dismissal). Nothing The Watch produces writes
to a repo or starts a run on its own — it is upstream of every existing gate.

```
              ┌──────────────────────────────────────────┐
   60s tick → │  scheduler.ts   (skip-if-inflight)        │
   +EventBus  │   ├─ cadence jobs   (time/event anchored) │
              │   ├─ ambient repo intake (Jules-style)    │
              │   └─ out-of-band watcher ──┐              │
              └────────────────────────────┼──────────────┘
                                           ▼
                        ┌─────────────────────────────────┐
   pluggable  ───────▶  │  HarnessSource registry          │
   sources             │   claude-code · codex · (cursor…) │
                        └─────────────────┬─────────────────┘
                                          ▼  normalized WorkRecord[]
                        ┌─────────────────────────────────┐
                        │  synthesizer (claude --print,    │
                        │  fenced JSON, null-parse-fail)   │
                        └─────────────────┬─────────────────┘
                                          ▼  Observation[]
                   dedup vs watch_observations  →  INBOX
                                          ▼
                operator: adopt as task │ record as convention │ dismiss
                          (the only path to a run or a repo write)
```

### 1. The scheduler primitive (build it, finally)

`apps/daemon/src/workers/scheduler.ts`, a third tick of the exact shape of the existing
two (`startUsageCapResumer` / `startInboxSnoozeResurfacer`, wired in `index.ts:189-191`):
a `setInterval` (default 60s) plus `EventBus` subscriptions. It owns a registry of
**jobs**, each `{ id, trigger, enabled, run() }` where `trigger` is `time` (a cadence:
hourly/daily/weekly) or `event` (`run_merged`, `plan_frozen`, `queue_empty`, …). The
**skip-if-inflight** discipline ADR-004 §"Trigger model" already designed is mandatory:
a job never starts if its prior invocation (or a relevant run) is still in flight. Jobs
are advisory by construction — they produce inbox items, never side effects.

Cadence jobs to seed (each lands results in the inbox as `notify`/`question`):
- **Backlog grooming / next-milestone** on `queue_empty` — replace the bare nudge at
  `apps/daemon/src/inbox/queue-empty.ts:53` with a decompose-next-milestone proposal
  (ties into ADR-009).
- **Scheduled health audits** — finally exercise the dormant audit primitive on a cadence.
- **Doc-drift / dependency sweeps** — time-anchored, low-effort "what changed" rhythm.

### 2. The pluggable `HarnessSource` interface (the architectural centerpiece)

A harness source is *any local record of engineering work Factory can observe*. The
interface is deliberately small and source-agnostic, and lives behind a registry that is
the **single source of truth**, exactly like `AGENT_REGISTRY`:

```ts
// packages/runtime/src/harness-sources/  (or apps/daemon/src/watch/sources/)

/** A normalized unit of out-of-band work, emitted by any source. */
export interface WorkRecord {
  sourceId: string;          // which harness ("claude-code", "codex", …)
  sessionId: string;         // stable id within that source
  projectPath: string | null;// cwd / repo the work targeted, if discoverable
  startedAt: number;         // epoch ms
  endedAt: number | null;
  title: string;             // short human summary of the session's intent
  summary: string;           // what happened: files, commands, outcome
  signals: WorkSignal[];     // typed extracts: corrections, new-skill, repeated-ritual…
}

export type WatchCursor = { sourceId: string; position: string }; // opaque, per source

export interface HarnessSource {
  readonly id: string;                       // "claude-code"
  readonly label: string;                    // "Claude Code"
  isAvailable(): Promise<boolean>;           // does its local store exist on this host?
  /** Incremental, READ-ONLY scan since `cursor`. */
  scan(cursor: WatchCursor | null): Promise<{ records: WorkRecord[]; next: WatchCursor }>;
}

/** Single source of truth. Adding a harness = one entry here; nothing else changes. */
export const HARNESS_SOURCE_REGISTRY: Record<string, HarnessSource> = {
  "claude-code": claudeCodeSource, // reads ~/.claude/projects/*/*.jsonl
  codex: codexSource,              // reads ~/.codex/ history
};
```

Adding Cursor, Amp, Gemini-CLI, or a future harness is a single `HarnessSource`
implementation + one registry entry. The synthesizer, the scheduler job, the cursor
table, and any future PWA surface all iterate the registry — **no consumer switches on
`sourceId`.** (Mirror `agents/registry.ts` exactly, including its documented "Known gap":
keep the registry in a place the daemon imports cleanly; if the CLI ever needs it, lift to
a `packages/`-level module rather than duplicating.)

The two initial sources are thin readers, not parsers of business logic: `claudeCodeSource`
walks `~/.claude/projects/<slug>/*.jsonl` (most-recent-first, bounded), `codexSource` walks
`~/.codex/`. Both are strictly read-only and **respect the `.env*` deny rules** — they never
open files matching secret patterns.

### 3. Synthesis (reuse Factory's existing agent-invocation discipline)

The out-of-band watcher job feeds the normalized `WorkRecord[]` to a `claude --print`
invocation — the same pattern as triage (`triage/orchestrate.ts`), plan iteration
(`plans/iterate.ts`), and audits: a tight prompt, a **fenced JSON** response, and
**null-parse → fail** discipline (never silently succeed). The synthesizer is
source-agnostic (it sees `WorkRecord`, not raw transcripts) and produces `Observation[]`:

```ts
type Observation = {
  kind: "repeated-ritual" | "new-convention" | "correction-pattern" | "candidate-task" | "tooling-gap";
  title: string;
  detail: string;
  evidence: { sourceId: string; sessionId: string }[]; // provenance, always
  proposal: "adopt-as-task" | "record-as-convention" | "note-only";
  targetProjectSlug: string | null; // if it maps to a known Factory project
};
```

### 4. The memory model — where synthesized knowledge lands

Factory has **no memory primitive today** (confirmed: no memory/profile/knowledge table in
`packages/db/src/schema.ts`). The Watch introduces the minimum, and it obeys the
**repo-canonical** and **operator-is-the-only-path-to-a-repo-write** contracts:

- **`watch_cursors`** (per source) — last-scanned position, so every tick is incremental
  and cheap. Pure index; rebuildable.
- **`watch_observations`** — every observation, with provenance and a status
  (`pending → surfaced → adopted | dismissed | superseded`). This is the **dedup key**:
  an observation already surfaced (or dismissed) is not re-raised, so the watcher respects
  the operator's finite attention and never nags. Pure index; the value is in what it
  promotes to.
- **Promotion targets (operator-gated, never automatic):**
  - *adopt-as-task* → `createTask` (the existing single-point-of-truth in
    `apps/daemon/src/projects/tasks.ts`) → enters the normal ready-queue / auto-advance.
  - *record-as-convention* → a **repo write the operator approves**: appends to the
    project's `AGENTS.md` (repo-canonical, survives a DB wipe), via the existing
    AGENTS.md writer seam. The Watch proposes the diff; the operator confirms.
  - *note-only* → stays a `watch_observation`, queryable, no write.

So "memory" is not a new opaque store — it is **observations indexed in the DB, promoting
into the artifacts Factory already treats as canonical** (tasks, AGENTS.md). Memory becomes
**Factory-earned** (the system observed it) rather than operator-curated, without violating
any write boundary.

**Project-level vs operator-level memory (resolves Open Question #4).** The promotions above
are *project-specific* (they have a `targetProjectSlug` → land in that project's `AGENTS.md`).
But many observations are *cross-project* operator patterns ("you always scaffold CLIs the
same 3 ways", "you prefer read-only-by-default CLI flags") with no project repo to call home.
"Repo-canonical per project" doesn't fit them. The decision: give operator-level memory its
**own git-backed repo** — the only target that satisfies all three contracts at once
(repo-canonical = survives a DB wipe, diffable; operator-gated = promotion is an inbox
approval; harness-neutral = Factory-owned, not coupled to `~/.claude`, which is just one
`HarnessSource`).

- **Store:** a single **Factory-owned, fresh** git repo, default `~/.factory/operator-memory/`
  (auto-init). Fresh by default *on purpose*: this store's job is to **synthesize new knowledge
  and surface patterns/ideas the operator may not have themselves** — an independent
  synthesizing intelligence, not a mirror of any harness's existing memory. (Path-configurable
  for relocation, but the default is not "adopt an existing repo.")
- **First run reviews everything.** Although the store is fresh, the **first synthesis pass
  ingests all existing memories across every registered harness** (Claude Code `MEMORY.md` +
  per-fact files + `lessons.md`, Codex history, …) as *input*, so day-one operator-memory is
  grounded in what's already been learned, then grows from observed work. Existing harness
  memories are a source to read, never the store to write.
- **Format:** the **same frontmatter-markdown Claude Code uses** — a `MEMORY.md` index plus
  per-fact files (`type: user | feedback | project | reference`). Keeps the store
  human-authorable and interoperable without coupling to any one harness's private layout.
- **First-class viewable, never opaque.** The operator-memory repo is a real git repo the
  operator can open directly, AND it is **browsable in the PWA** as a first-class read surface
  (the `MEMORY.md` index + each fact, with provenance) — not buried behind a config directory
  or hidden inside the synthesis machinery. This is a *reference* surface (read), not a new
  attention sink: the inbox stays the only thing that demands action
  ([[feedback_dashboard_inbox_in_flux]]).
- **Symmetry:** The Watch *reads* many harness memories (pluggable sources) and *writes* one
  synthesized operator memory. Project conventions → project `AGENTS.md`; operator conventions
  → the operator-memory repo. **Same writer discipline, different target repo.**
- **Payoff (why this over a DB table):** the operator-memory repo is **injectable as run
  context** — a Factory run reads it the way it reads `AGENTS.md`, so autonomous work is
  grounded in the operator's *observed* practice. Memory only humans read is a diary; memory
  the next run reads is leverage.
- **Seam:** one IO module (`operator-memory.ts`), single-point-of-truth like the other
  repo-canonical writers, swappable to a remote (GitHub repo / gist) per the
  "remote storage is a one-file change" contract.
- **Before writing, read:** the synthesizer loads the (small) existing operator memory so it
  *updates* an existing fact rather than duplicating — the same "check for an existing file
  that already covers it" discipline the memory format itself prescribes.

Rejected: Factory's own `AGENTS.md` (conflates building-Factory with operator-habits);
DB-only (loses the most valuable artifact on a wipe — keep it as the *index*, not the source);
fan-out into every project's `AGENTS.md` (duplicative, drifts); writing back into
`~/.claude/.../memory` directly (couples to one harness — interop is opt-in via config, not
hardwired).

### 5. Inbox surfacing (single attention sink, graduated grammar)

Observations surface as a new decision kind **`watch_insight`** (add to the `decisions`
kind enum, `packages/db/src/schema.ts:14-26`). It is a **`notify`/`question`-grade** item
in the LangChain ambient grammar, never a blocking `review`: "Across 4 recent Claude Code
sessions you scaffolded CLIs by hand with the same 3 steps — adopt as a `cli-scaffold`
task template? [adopt / record convention / dismiss]." It carries provenance (which
sessions) and is dismissible-without-action. The inbox stays the *only* attention sink
([[feedback_dashboard_inbox_in_flux]] — no new surface).

For self-generated *repo* intake (the Jules-Suggestions-style ambient job in §1), the
producer reuses the existing **idea intake** path (`routers/ideas.ts`): `ideas.source` is
free-text (`text("source").notNull()`, schema line 310), so a new source value like
`"watch"` needs **no schema change** — the idea flows into normal triage.

## Contracts respected

- **Read-mostly; operator is the only path to a repo write** (VISION, ADR-004 §9). The
  Watch reads, synthesizes, and proposes. Every repo write (convention → AGENTS.md) and
  every run (task adoption) goes through an operator action. No exceptions.
- **Single attention sink.** One new inbox kind, `notify`-grade, dedup'd against
  `watch_observations` so it cannot nag.
- **Repo-canonical artifacts.** Promotions land in tasks / AGENTS.md, not a Factory-only
  blob. DB tables are indexes.
- **Honest invocation.** Synthesis uses the `claude --print` + fenced-JSON + null-parse-fail
  discipline; a failed synthesis is `failed`, never a silent empty result.
- **Pluggability is structural, not optional.** Sources and jobs are registries; no consumer
  branches on harness id.

## Data model additions

- `decisions.kind` enum: `+ watch_insight`.
- `ideas.source`: new value `watch` (no schema change — free text).
- New tables: `watch_cursors`, `watch_observations` (both index-only; a wipe loses history,
  not project value). Migration checked in per convention.
- No changes to runs, plans, tasks schemas.

## Consequences

- Factory gains a heartbeat: it grooms, audits, and proposes on a cadence the operator no
  longer hand-rolls in `/loop`/`/schedule`.
- Factory gains awareness of the operator's whole engineering surface, and its memory starts
  compounding from observed practice.
- New failure surface: a chatty or low-precision synthesizer. Mitigation: precision-as-product
  (Graphite's lesson) — dedup hard, default to `note-only`, and make `watch_insight` trivially
  dismissible. If the operator dismisses a class of insight repeatedly, the job self-throttles.
- Cost: each out-of-band synthesis is a `claude --print` call on a cadence. Bounded by the
  scan window and the tick interval; gated by `isAvailable()` and skip-if-inflight.

## What stays out (this ADR)

- **No autonomous repo writes or run starts from The Watch.** That is the Trust Ladder's job
  (WS A), gated by the Verifier-Coverage score (WS C) — and even then, never from observation
  alone.
- **No PWA "watch activity" dashboard.** Watch *observations* live in the existing inbox; a
  dashboard of watch runs/activity is out. (Distinct from the operator-memory **viewer** in §4,
  which IS in scope — a read-only browse of the memory repo: a reference surface, not an
  attention sink.)
- **No remote/cloud sources.** v1 sources are local-disk only (`~/.claude`, `~/.codex`).

## Open questions

1. **Scan windowing.** How far back does the first scan go, and how is the bound expressed
   (N sessions? last K days?) to keep the first synthesis cheap and relevant?
2. **Project mapping.** A `WorkRecord.projectPath` may or may not map to a Factory project
   slug. When it doesn't, is the observation operator-level (cross-project) or dropped?
3. **Synthesis cadence vs. event.** Does the out-of-band watcher run purely on a timer
   (e.g. nightly), or also opportunistically when `queue_empty` gives Factory spare capacity?
4. ~~**Operator-level vs project-level memory.**~~ **Resolved in §4:** cross-project operator
   memory gets its own **fresh, Factory-owned**, git-backed, Claude-Code-format operator-memory
   repo (default `~/.factory/operator-memory/`), injectable as run context, **first-class
   viewable in the PWA**. Fresh by default because the store's job is to synthesize and surface
   what the operator *doesn't* already know; the first synthesis pass nonetheless ingests all
   existing harness memories as input.
