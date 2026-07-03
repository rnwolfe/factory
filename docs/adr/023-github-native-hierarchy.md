# ADR-023 — Native GitHub epic/sub-issue hierarchy

**Status:** accepted · **Date:** 2026-07-03 · Extends ADR-021 (task pipeline) §4b (hierarchy axis) and ADR-019 (dependencies).

## Context

ADR-021 defined three orthogonal task axes — lifecycle, ordering, and **hierarchy** (epic → sub-issue) — but only lifecycle and ordering shipped. `parent` existed on the task model as inert provenance: nothing read it, derived from it, or rendered it.

The gap surfaced concretely: the **backbar** project was organized *on GitHub* into 4 epics (`Epic: …` issues) with 17 native sub-issues (GitHub's GA sub-issue relation, `parent`/`subIssuesSummary`). Factory saw **none** of it — the GitHub sub-issues API was called nowhere, `IssueApi` didn't even deserialize the fields, and `parent` was only ever read from Factory's own `factory:task` meta block, which GitHub-authored issues don't carry. Neither natural sync nor the "organize backlog" enrichment gleaned the structure.

## Decision

Make GitHub's **native** sub-issue relation the source of truth for `parent` on the GitHub backend, read it into the task model, derive an epic rollup, treat epics as containers, and let Factory write the relation back.

1. **Ingestion (GitHub-authoritative).** `GithubIssuesStore.list()` issues one GraphQL pass fetching every issue's native `parent`, and overlays it onto each task's `frontmatter.parent` (meta-block `parent` remains a fallback for pre-native Factory links). Hierarchy is enrichment — a GraphQL failure degrades to "no hierarchy," never fails `list()`.

2. **Two-way write.** A new `TaskStore.setParent(taskId, parentId | null)` writes the relation: the GitHub backend calls the native sub-issues REST API (`POST/DELETE …/sub_issues`, keyed on the child's database `id`), reparenting cleanly and rejecting cycles; the file backend writes `parent:` frontmatter. Exposed as `projects.tasks.setParent` and an "assign to epic" control on the task page.

3. **Derivation.** The router derives `children` (inverse of `parent`), a GitHub-style `subIssuesSummary {total, completed}` rollup (computed from Factory's own task statuses, so it matches the board), and `isEpic`, mirroring the existing `blocks` derivation.

4. **Epics are containers, not runnable work.** `isStartable` returns false for any task with children — auto-advance picks the *children*, never the epic. An agent must never try to "do the epic" instead of its sub-issues.

5. **Opt-in rollup auto-close.** `hierarchy.epicAutoClose` (autonomy config, **default off**) closes an epic once all its children are terminal (`done`/`dropped`). Wired at the two terminal-transition seams (operator `updateStatus`, run-completion post-merge). Idempotent.

## Consequences

- Hierarchy organized on GitHub is read back faithfully; Factory-authored hierarchy round-trips through the same native relation, so the two never drift.
- Epics don't pollute the run queue, and the board surfaces the structure (epic rollup badge, `↳ #parent` chip, child list).
- **Rejected:** persisting `parent` into the meta block at adopt time (would drift from GitHub-side reparenting) — we read fresh instead. **Deferred:** nested lane rendering / drag-to-reparent on the board (chips + a select suffice for now); native migration of `blockedBy` onto GitHub's dependency API (ADR-019's separate follow-up).
- Cost: one extra GraphQL call per GitHub-backend `list()`. Bounded (≤10 pages) and failure-tolerant.
