# Research spike — first-class task lifecycle, ordering & hierarchy

**Date:** 2026-07-01 · **Status:** spike (pre-ADR) · **Author:** session with operator

Operator prompt: *"we need more first-class support for task flowing through the
pipeline (e.g. `inbox → backlog → ready → pending → complete`), a means for the
operator to order tasks entering the queue, and parent/child (sub-issue / epic)
relationships — all considered in the PWA UX and the pluggable tasking
interface."*

This doc captures the spike (current-state map + prior-art research), reconciles
the proposal with both, and lays out a recommended model + phasing + the open
decisions to settle before an ADR.

---

## 1. Current state (what we have today)

- **Statuses** (`tasks.ts`): `needs_triage | ready | in_progress | review | done | blocked | dropped`.
  - **`in_progress` and `review` are vestigial** — nothing in the daemon writes
    them. The *run* row's `status="running" | "needs_review"` is the canonical
    in-flight/verify signal (`runner.ts:265-270`); the PWA enriches task rows
    with the active run. So the truly code-driven lifecycle is
    `needs_triage → ready → (run) → done | blocked`, plus `dropped`.
  - `needs_triage` (ADR-020) is the only pre-ready holding state; reached only
    via GitHub adopt. `ready` is the **only** startable status (`isStartable`).
  - `blocked` = a run tried and couldn't finish (unmet acceptance / partial) —
    an *execution-attention* state, distinct from dependency-blocked.
- **Ordering:** `pickNextReadyTask` picks the first startable task in **numeric
  id order** (after the just-finished id). **`priority` is written everywhere
  but read by NO pick path** — it's dead weight in ordering. There is no manual
  reorder, no rank, no lanes.
- **Hierarchy:** `parent` and `milestone` are **provenance only** — no pick,
  order, or display path reads them. No epic/sub-issue concept. The only real
  relation is `blockedBy` (ADR-019): a DAG that gates `isStartable`, stored in
  file frontmatter / GitHub meta block, with derived `openBlockers`/`blocks` and
  cycle rejection.
- **Pluggable seam:** `TaskStore` interface + registry (`file`, `github-issues`).
  GitHub maps status → open/closed + a single `status:*` label + the
  `factory:task` meta block. `blockedBy` lives in the meta block today (native
  GitHub dependency API noted as a future slice).
- **Inbox vs plans vs tasks:** "inbox" today is a **decisions** concept (the
  attention sink), not a task concept. **Plans** (project_spec/feature_plan/…)
  are pre-task drafting artifacts that emit tasks via `createTask` on freeze.
  So the proposed `inbox/backlog/pending` lanes overlap three distinct existing
  mechanisms — this is the main reconciliation risk.
- **PWA:** the task board is a **flat active/archived list**, not lanes. Status
  is a chip; the only operator transitions are start / mark-ready / drop +
  the dependency editor.

## 2. Prior art (industry shape)

- **Two-layer model everywhere:** a customizable *state label* mapped onto a
  small *fixed category enum* (for rollups/boards/automation).
- **Load-bearing buckets** (universal): `todo/unstarted`, `in-progress`, `done`.
  Divergences are the signal:
  - **Triage vs Backlog** (only Linear separates): *"should this exist?"* vs
    *"accepted, not scheduled."*
  - **Ready vs Backlog:** *groomed & pickable* vs *raw* — critical for an
    auto-advancing picker (it should only pull `ready`).
  - **Review is never its own category** — at most a state typed under
    in-progress.
  - **Two terminals** (`done` vs `canceled`) — only Linear; the sharpest, most
    worth-adopting distinction (a single terminal corrupts throughput metrics).
  - **Blocked is an attribute, not a state** — a dependency edge/flag.
- **GitHub native primitives went GA 2025-03-17** and are bot-writable, issue-scoped:
  - **Sub-issues** (parent/child): 100/parent, 8 levels deep, one parent. REST +
    GraphQL, incl. a reorder endpoint and `subIssuesSummary {total, completed,
    percentCompleted}`.
  - **Issue Types** (task/bug/feature/epic-ish): org-level, 25/org, needs
    org-admin to manage the catalog; settable per-issue.
  - **Issue dependencies** (blocked-by/blocking): native, CLI/API-manageable as
    of 2026-06-10 — GitHub can now represent both hierarchy *and* the DAG.
  - **Richer status is NOT issue-scoped** — Todo/In-Progress/Done is a
    ProjectV2 item field, not on the issue. → **Model lifecycle state as labels**
    (issue-native, no Project, no permission dance), never as a Project Status.
- **Ordering:** priority enum (coarse bucket) + a **fractional-index `rank`
  string** (fine position). Reorder = single-row write. Float indices exhaust
  precision (~52 inserts); use LexoRank/`fractional-indexing`-style strings.
- **Epics vs deps stay orthogonal:** parent/child = containment + rollup, does
  **not** gate startability; blocked-by = the only relation feeding "ready."
  Rollup/auto-close is an **opt-in policy**, off by default; an epic is a real
  workable issue, not just a folder.

## 3. Verdict on the proposed pipeline

`inbox → backlog → ready → pending → complete`:

- ✅ The `inbox → backlog → ready` split is well-grounded (mirrors Linear
  Triage → Backlog → Unstarted) and is exactly what an auto-picker wants.
- ⚠️ **`pending` is ambiguous** (started? awaiting review? blocked?). No
  reference system uses a word this vague → rename to **`in_progress`/started**.
- ⚠️ **One terminal is a defect** → add **`dropped`/canceled` parallel to
  `complete`** (Factory already treats `dropped` as distinct — make it explicit).
- ➕ An **`in_review`/verify** state is justified (Factory has a real
  verify/quality + decision step) — but typed *under* in-progress, not a
  top-level bucket.
- ➕ Keep **`blocked` as an attribute** (the `blockedBy` DAG), not a lifecycle slot.

## 4. Recommended canonical model

Three **orthogonal** axes, each mapping to a GitHub-native primitive *and* a
trivial markdown field (no lowest-common-denominator loss):

### 4a. Lifecycle state (the operator-controlled pipeline)

Persisted on the task: **`needs_triage → backlog → ready → done`**, plus
terminal **`dropped`**, plus **`blocked`** (execution-attention). Rename display:
`needs_triage` shows as **"triage / inbox"** (keep the id to avoid collision with
the *decisions* inbox and to preserve ADR-020's shipped label).

- `needs_triage` = adopted/unvetted (today's ADR-020 state) = the "inbox" bucket.
- `backlog` = **NEW** — vetted/accepted, not yet queued to run. (The missing
  middle today.)
- `ready` = queued & pickable — the **only** startable status.
- `done` (→ closed/`completed`) / `dropped` (→ closed/`not_planned`) — two terminals.
- `blocked` = a run couldn't finish; needs operator attention.

**Open decision D1 (execution states):** `in_progress` / `in_review` are
*derived from the active run* today (run status is canonical). Recommendation:
**keep deriving them for the board** (compose persisted-status + live run-status
into lanes) rather than persisting them on the task — this matches "engine
decides what" and avoids write-races between runner and task file. The board
shows an "in progress" / "in review" lane populated from active runs; the task's
*persisted* status stays `ready` until the run terminates it to `done`/`blocked`.

### 4b. Hierarchy (epic → sub-issue) — NEW, orthogonal

- Parent/child containment with **opt-in rollup** (off by default); does **not**
  gate startability.
- GitHub → **native sub-issues**; file → `parent:` frontmatter + derived children
  + an emulated `subIssuesSummary` (trivially computed).
- An epic is a workable task with its own status; "all children done" can
  optionally auto-complete it (policy toggle, later).

### 4c. Ordering — NEW

- A **`rank` fractional-index string** per task (+ keep the `priority` enum as a
  coarse bucket; sort `(priority, rank)`). Reorder = rewrite one task's
  `rank` (frontmatter field / GitHub meta or the sub-issue priority endpoint).
- `pickNextReadyTask` sorts ready tasks by `(priority, rank)` instead of numeric
  id — this is the operator's "order the queue" lever.

### 4d. Pluggable interface deltas

`TaskStore` gains: `setParent/listChildren` (or a generic relation op),
`setRank/reorder`. GitHub backend maps these to native sub-issues + the
dependency API (finally moving `blockedBy` off the meta block onto native deps)
+ a `rank` meta/field; file backend to frontmatter. **Status stays label-based
on GitHub** (never a Project Status).

## 5. PWA UX direction

- Move the task board from flat active/archived to **lifecycle lanes**
  (triage · backlog · ready · in progress · review · done), phone-first: lanes as
  a horizontal-scroll or vertical accordion at 390px.
- **Drag to reorder** within `ready` (writes `rank`); **drag across lanes** to
  change state (with the ADR-020 guard — promoting into `ready` is the deliberate
  gate).
- **Epic grouping:** collapse/expand children under a parent, with a rollup
  progress bar (`subIssuesSummary`).
- Keep the dependency editor; surface `blocks`/`blockedBy` on the card.

## 6. Proposed phasing

1. **Spike + ADR** (this doc → ADR-021).
2. **Lifecycle:** add `backlog`; formalize the derive-vs-persist execution-state
   decision (D1); label/meta mapping; migrate `needs_triage` semantics; board
   shows triage/backlog/ready distinctly.
3. **Ordering:** `rank` field + `pickNextReadyTask` sort + operator reorder UI.
4. **Hierarchy:** parent/child at the `TaskStore` seam; GitHub native sub-issues;
   file emulation + rollup; epic grouping in the PWA.
5. **Native GitHub deps:** move `blockedBy` off the meta block onto the native
   dependency API (ADR-019 follow-up).
6. **PWA lane board** polish (drag, phone-first) — can interleave with 2-4.

Each phase is independently shippable and releasable.

## 7. Open decisions — RESOLVED (see ADR-021)

- **D1 — execution states:** ✅ **derive** `in_progress`/`in_review` from runs.
- **D2 — lifecycle naming:** ✅ **keep `needs_triage`** (display "triage") + add
  **`backlog`**.
- **D3 — scope:** ✅ **one ADR** (all three axes) + **phased build**.
- **D4 — GitHub status carrier:** ✅ **labels-as-canonical-status** (not Project).
- **D5 — rollup policy:** ✅ **opt-in auto-close** (per-project/epic toggle, default off).

Resolved into [`docs/adr/021-task-pipeline.md`](../adr/021-task-pipeline.md).
