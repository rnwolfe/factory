# ADR-019 · Task dependencies — `blocked-by` edges for ordered multi-step work

**Status:** proposed (2026-06-29)
**Scope:** the task model gains a dependency edge; the ready-pool gate and every
work-pick path respect it; the GitHub-Issues backend maps it onto GitHub's native
issue-dependency + sub-issue relations.
**Builds on:** ADR-007 (GitHub Issue backend), ADR-015 (harness/backend extensibility),
ADR-009 (milestone decomposition), ADR-012/016/017 (autonomy: trust ladder, auto-advance,
Phase-C auto-run). This is the smallest model that makes "self-moving" mean "self-moving in
the *right order*."

## Context

Tasks today are an **unordered ready-pool**. There is no dependency, subtask, or ordering
model:

- The task frontmatter (`apps/daemon/src/projects/tasks.ts:20-52`) carries `parent` and
  `milestone`, but these are **provenance/grouping metadata** — nothing in any pick path reads
  them. There is no `blockedBy`/`dependsOn`/`order` field.
- "Next ready" is purely **numeric-id order**: `pickNextReadyTask` (`tasks.ts:104-115`) returns
  the first `status==="ready"` task after the just-finished id; the UI's `nextStartableTask`
  (`routes/project-detail.tsx`) is `tasks.find(t => t.status === "ready")`.
- Auto-advance (`workers/post-merge.ts:140`) uses `pickNextReadyTask` and submits the next run
  only when **no other run is in flight** for the project (`post-merge.ts:134`). Autorun
  eligibility (`autonomy/auto-run.ts`) bounds *Watch proposals* per tick, not ready-task
  execution — but Phase-C (ADR-017) is the direction of travel.

**The gap:** a feature decomposed into five sequential steps becomes five independent ready
tasks. The *only* things imposing order are (a) implicit id ordering and (b) one-run-at-a-time.
Nothing encodes "step 3 needs step 1 merged first." As autonomy widens (auto-advance already
chains; Phase-C will auto-submit), an agent can start step 3 against a tree that doesn't yet
have step 1 — producing conflicts, rework, or silently wrong sequencing. The ready-pool needs
**edges**.

GitHub shipped exactly this model, and Factory already has a GitHub-Issues task backend
(ADR-007) — so the edge should **map 1:1 to GitHub's native relations**, not invent a parallel
vocabulary.

### GitHub's model (the thing to align with)

GitHub has **two distinct relations** (their own framing: sub-issues are 1→many hierarchy;
dependencies are many↔many blocking):

| GitHub relation | Meaning | REST API | CLI |
|---|---|---|---|
| **Sub-issues** (GA) | parent → child *decomposition* (1→many), with progress rollup | `GET/POST/DELETE /repos/{o}/{r}/issues/{n}/sub_issues` | — |
| **Issue dependencies** (GA 2025-08-21) | "blocked by" / "blocking" *gating* (many↔many), shows a **Blocked** marker | `GET/POST/DELETE /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` (+ `…/blocking`) | `gh issue create --blocked-by --blocking` |

The dependency `POST` body is `{"issue_id": <internal integer id>}` — **not** the issue number;
`DELETE` is `…/blocked_by/{issue_id}`. (Sources at the bottom.)

The key insight GitHub encodes: **hierarchy ≠ ordering.** Sub-issues decompose; they don't
gate (children can be done in any order). Dependencies gate. Factory needs both, and already
half-has the first (`parent`).

## Decision

Add one edge — `blockedBy` — and derive a gate from it. Keep `parent` as decomposition.

### 1. Data model (additive, backend-agnostic)

Extend `TaskFrontmatter` / `CreateTaskInput` (`tasks.ts`):

```yaml
blockedBy: ["task-003", "task-004"]   # task ids this task waits on; default [] = today's behavior
```

- **Many-to-many.** `blocks` is the inverse and is **derived** (scan the pool), never stored —
  one source of truth per edge.
- `parent` stays as-is (decomposition / sub-issue link). A task may have both a `parent` and
  `blockedBy` (a sub-step that also depends on a sibling).
- Stored in the task store, so it rides the existing seam (ADR-015): file backend → frontmatter;
  GitHub backend → the dependencies API (§4). No new DB table (tasks remain file/issue-backed).

### 2. The startable predicate (derive, don't store)

A task's *stored* status is unchanged; "blocked by an unmet dependency" is **computed**, so a
dependency completing makes its dependents startable instantly with no status write or daemon
sweep:

```ts
// one predicate, consumed everywhere
export function isStartable(task: TaskFile, byId: Map<string, TaskFile>): boolean {
  if (task.frontmatter.status !== "ready") return false;
  const deps = task.frontmatter.blockedBy ?? [];
  return deps.every((id) => {
    const dep = byId.get(id);
    // unknown dep → treat as satisfied (don't deadlock on a stale id); a dropped
    // dep is satisfied too — only an open dep gates.
    return !dep || dep.frontmatter.status === "done" || dep.frontmatter.status === "dropped";
  });
}
```

The existing manual `status: "blocked"` (operator-set) stays distinct from *dependency*-blocked:
manual-blocked is "a human parked this"; dependency-blocked is "ready, but waiting on an edge."
Both are non-startable; the UI distinguishes them.

### 3. Wire the gate into every pick path

`isStartable` replaces the bare `status === "ready"` checks at all four sites:

- `pickNextReadyTask` (`tasks.ts:104-115`) — skip tasks with unmet deps (still forward-only).
- Auto-advance (`workers/post-merge.ts:140`) — picks the next *startable* task.
- Autorun eligibility (`autonomy/auto-run.ts`) — a code-run autorun (when that class lands) must
  refuse a task with unmet deps; the gate composes with the existing eligibility conjunction.
- UI `nextStartableTask` (`routes/project-detail.tsx`) + the task board — the "start run" button
  only offers startable tasks.

Because deps are derived, no migration of in-flight state is needed; an empty `blockedBy` (every
existing task) reproduces today's behavior exactly.

### 4. GitHub-backend mapping (align, don't reinvent)

`apps/daemon/src/projects/github-task-store.ts` is the seam. A GitHub-backed task's id is the
issue number (`github:owner/repo#N`); the dependency API keys on the issue's **internal
`issue_id`**, so the store resolves number→id (one issue GET, cached) when syncing.

| Factory edge | GitHub relation | Endpoint |
|---|---|---|
| `blockedBy` (read) | dependencies | `GET …/issues/{n}/dependencies/blocked_by` → map issue numbers back to `github:…#N` ids |
| `blockedBy` add | dependency | `POST …/issues/{n}/dependencies/blocked_by` `{issue_id}` |
| `blockedBy` remove | dependency | `DELETE …/issues/{n}/dependencies/blocked_by/{issue_id}` |
| `parent` | sub-issues | `…/issues/{n}/sub_issues` (already a candidate for ADR-007 follow-up) |

The **file backend is the source of truth for its own deps** (frontmatter); the GitHub backend
treats GitHub's dependency graph as the source of truth and surfaces it as `blockedBy`. The
`isStartable` gate reads `blockedBy` identically regardless of backend — the alignment is in the
store, not the gate. When the deps API is unavailable (older GHE, missing scope), fall back to a
body convention (`Blocked by #N`) parsed read-only, and log that writes are no-ops (fail honest,
per the autorun "ships dark" precedent).

### 5. Decomposition emits chains

The two paths that already create *sets* of tasks should emit dependency chains so the model is
populated without manual wiring:

- **Milestone decomposition** (`projects/milestone-decompose.ts`) and **feature-plan freeze**
  (`plans/apply-feature-plan.ts`) — when the model marks steps as sequential, set each task's
  `blockedBy` to the prior step's id. The plan/feature-plan draft schema gains an optional
  per-task `dependsOn` (by draft-local index) that freeze resolves to real task ids.
- Default remains **no edges** (parallel) — dependencies are opt-in per decomposition, so we
  don't over-serialize independent work.

### 6. Cycle prevention + validation

- Adding an edge that would create a cycle is rejected at the tRPC mutation (DFS over the pool).
- Self-edge rejected; unknown dep id allowed but logged (treated satisfied, never deadlocks).
- `blockedBy` capped (e.g. 50, matching GitHub's relationship ceiling) to bound the scan.

### 7. UI

- A dependency-blocked task renders a **parked** `blocked · waiting on task-003` chip (reusing
  the verdict-parked token from the Heimdall pass) and is non-interactive for "start run."
- The task detail shows its `blockedBy` and derived `blocks` as linked rows.
- The project overview "ready" vital (added in the Heimdall pass) counts **startable** tasks, so
  "ready" stays truthful — a task waiting on a dep is *ready-but-gated*, not startable.

## Consequences

- **Sequential features are modeled.** Auto-advance and (future) Phase-C autorun execute steps in
  dependency order, not id-luck order; the single-run-in-flight guard becomes a correctness
  backstop rather than the only ordering.
- **GitHub parity.** Operators who live in GitHub Issues see Factory's edges as native
  "blocked by" relations and vice-versa — no parallel vocabulary, and `gh issue create
  --blocked-by` round-trips.
- **Additive + reversible.** Empty `blockedBy` = today. No schema migration (file/issue-backed).
  The gate is one predicate; deleting the edges reverts behavior.
- **Bounded scope.** This ADR is *ordering* only. It deliberately does **not** add scheduling,
  priority-based selection, or parallel multi-run-per-project — those remain separate decisions.

## Open questions (for operator review)

1. **Sub-issue sync now or later?** `parent` ↔ sub-issues is a clean follow-up but not required
   for the gate. Ship `blockedBy` ↔ dependencies first; wire sub-issues when hierarchy rollup is
   wanted in the UI?
2. **Auto-derive sequential chains?** Should milestone/feature-plan decomposition default to a
   linear chain (safe, maybe over-serialized) or stay parallel-by-default and only chain when the
   model explicitly orders steps? (Leaning: parallel-by-default, explicit ordering — matches
   "engine decides what, model decides when.")
3. **Display of a gated task in the inbox "in flight"/ambient surfaces** — none, since it isn't
   running; it only appears on the project board with the blocked chip. Confirm that's right.

## Sources

- GitHub — *Dependencies on issues* (GA, 2025-08-21):
  https://github.blog/changelog/2025-08-21-dependencies-on-issues/
- GitHub Docs — *Creating issue dependencies*:
  https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
- GitHub Docs — *REST API endpoints for issue dependencies* (`dependencies/blocked_by`):
  https://docs.github.com/en/rest/issues/issue-dependencies
- GitHub Docs — *REST API endpoints for sub-issues*: https://docs.github.com/en/rest/issues/sub-issues
