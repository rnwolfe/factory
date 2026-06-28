# ADR-013 · Autonomy & operations metrics — a first-class, historical ops surface

**Status:** proposed (2026-06-28)
**Scope:** the autonomy initiative — cross-cutting observability (operator directive).
**Relates to:** instruments ADR-010 (Watch), ADR-011 (work-generator), ADR-012
(Trust Ladder). Extends `routers/ops.ts` + `routers/metrics.ts` + PWA
`ops.tsx`/`metrics.tsx`. Honors VISION.md ("a complementary operational-awareness
layer that doesn't become a second inbox").

## Context

The autonomy work only earns trust if its effectiveness is **observable**. The
north-star is decisions-per-run → 0; the operator needs to *watch it move* — per
project and in total, over time — alongside the Trust Ladder's auto-ratify /
override rates, the Watch's self-proposed-work completion, and the distribution
of projects across autonomy levels. Operator directive (2026-06-28): the whole
autonomy class of features ships with **first-class metrics and ops surfaces**,
**historically viewable**, and some of the asks (commit rate, LOC shipped, active
projects) are a standing observability gap regardless of autonomy.

What exists today:
- `routers/ops.ts` — live runs, recent terminal activity (24h), active sessions,
  usage aggregation across today/week/month windows.
- `routers/metrics.ts` — agent **cost / tokens / duration** aggregates (from
  `recordAgentMetrics`).
- PWA `ops.tsx` / `metrics.tsx` render these as **live snapshots / tables**.

The gaps (verified): **no time-series storage** (no rollup table), **no charts**
(the surfaces are numeric/tabular), and **none of the autonomy or
operational-throughput metrics** below. So this ADR adds a *history + chart*
layer and a metric catalog on top of the existing live surface — it does not
replace it.

## Decision

A **read-only, historical, first-class** metrics layer that extends the existing
ops/metrics surface, built on four parts: a metric catalog, hybrid storage, a
time-series API, and charts. Metric emission becomes a **build requirement** for
every autonomy feature (cross-cutting).

### 1. The metric catalog

Each metric is `{ key, scope (project|portfolio|both), source, snapshot|flow }`.

**Autonomy-effectiveness:**
- `decisions_per_run` — decisions created ÷ runs (the north-star). `decisions`+`runs`.
- `auto_ratify_rate` — `auto_ratified` ÷ all `agent_decision` (Trust Ladder L2 reach).
- `override_rate` — overrides of `auto_ratified` ÷ `auto_ratified` (trust signal; high → contract).
- `watch_proposals_{created,completed,merged}` — Watch-generated work through the funnel.
  `watch_observations` + tasks labelled `watch` / `sourceDecisionId` + runs.
- `projects_by_autonomy_level` — snapshot distribution. `projects.autonomyMode` (→ trustLevel).
- `chain_depth_{avg,max}` — auto-advance chain length (auto-merge compounding).

**Operational (the standing gap):**
- `runs_{total,completed,failed}`, `throughput` (completed/day). `runs`.
- `auto_merge_rate`, `merge_conflicts`. `runs` + `merge_failure` decisions.
- `active_projects` — snapshot (activity in window). `projects.lastActivityAt`/`runs`.
- `commits` (per-project + total), `loc_added` / `loc_removed`. **git** (see storage).

### 2. Storage — hybrid (compute-on-read + daily rollups)

Most metrics are cheap to compute on-read from SQLite (`runs`, `decisions`,
`projects`) and should be for **live / today**. History and the **git-derived**
metrics (commits, LOC) need a rollup:

- **`metrics_daily`** — long format: `(date TEXT, projectId TEXT NULL, metric TEXT,
  value REAL, updatedAt)` with `UNIQUE(date, projectId, metric)`. Long format so a
  new metric is a new computation, **not a migration** ("etc etc" is free).
  `projectId NULL` = portfolio total.
- **Rollup job** — a daily cadence job on the Watch scheduler (ADR-010 §1) that, for
  the prior day, computes every catalog metric per project (DB aggregates +
  `git log --numstat --since` against each project workdir for commits/LOC) and
  **upserts** into `metrics_daily`. Idempotent; a missed day is recomputed on the
  next run. LOC/commits count **what landed on `main`** (merged work), so the
  number reflects shipped value, not churn.
- **Backfill** — a one-shot to populate history from existing `runs`/`decisions`
  (back to first run) + `git log` (bounded lookback), so charts have depth on day one.

Compute-on-read for the live "today/now" tiles; `metrics_daily` for any historical
range. This keeps live numbers exact and history cheap.

### 3. Time-series API

Extend `metricsRouter`:
- `metrics.series({ metric, projectId?, from, to, granularity })` → `[{ date, value }]`
  (reads `metrics_daily`).
- `metrics.snapshot({ projectId? })` → current values (compute-on-read) for the live tiles.
- `metrics.catalog()` → the metric definitions (so the PWA renders without hardcoding).

### 4. PWA — first-class charts, read-only

Extend `ops.tsx`/`metrics.tsx` (or a dedicated autonomy view) with real,
**first-class time-series charts** — per-project and portfolio — in the
dispatcher's-console aesthetic (warm-dark, amber, dense, no chrome). **Use a real
charting library; do not hand-roll SVG and do not reinvent metric visualization.**
The library must be (a) themeable to the bespoke palette (CSS-var driven, not a
prescriptive design system that fights it), (b) React-native + declarative, (c)
strong at time-series (axes, tooltips, range/brush, responsive), (d) light enough
for a phone-first PWA.

- **Recommendation: Recharts** — mature, declarative, fully themeable, ubiquitous;
  composable primitives (Area/Line/Bar/Tooltip/ResponsiveContainer) that take our
  CSS-var colors directly.
- **Escape hatch: visx** (low-level primitives — real scales/axes/shapes with full
  aesthetic control) for any chart Recharts can't style to spec.
- **Rejected:** hand-rolled SVG (reinvents the wheel — operator vetoed) and
  all-in-one dashboard kits (e.g. Tremor) whose prescriptive styling fights the
  dispatcher aesthetic.

Phone-first (390px). **Read-only** — awareness, not action; the inbox stays the
only attention sink.

### 5. Cross-cutting: metric emission as a build requirement

Every autonomy feature lands with its effectiveness metric in the catalog + the
rollup computation. The catalog is the single source of truth (the API and PWA
read it), so "add a metric" = one catalog entry + one computation, no schema or UI
churn. This is how we keep the directive honest as Slices ship.

## Contracts (don't break)

- **Read-only, not a second inbox** (VISION). No tile links to an action; nothing
  here demands attention. The inbox remains the sole attention sink
  ([[feedback_dashboard_inbox_in_flux]]).
- **Shipped value, not churn.** LOC/commits count merged-to-`main` work, so the
  numbers track what actually landed.
- **History survives a DB wipe?** No — `metrics_daily` is a derived rollup, and the
  backfill can rebuild it from `runs`/`decisions` + git. It's an index, not a source
  of truth (consistent with the repo-canonical contract).

## Build sequence

1. **Schema + rollup job + backfill.** `metrics_daily`, the daily cadence job, the
   one-shot backfill. Seed the catalog with the north-star (`decisions_per_run`) +
   a few operational (`throughput`, `commits`, `loc_added/removed`,
   `projects_by_autonomy_level`) to prove the pipeline end-to-end.
2. **Time-series API** (`series`/`snapshot`/`catalog`).
3. **Charts** in the PWA ops surface.
4. **Backfill the rest of the catalog** + wire each remaining autonomy metric as its
   Slice lands (auto_ratify_rate/override_rate with Trust Ladder Slice 2;
   watch_proposals_* with the Watch generator).

## Open questions

1. **Rollup vs compute-on-read boundary.** Proposed: live=compute-on-read,
   history=rollup. Is any historical metric cheap enough to always compute-on-read
   (skip the rollup)? (decisions/runs are; LOC/commits are not.)
2. **LOC accounting.** Merged-to-`main` numstat per day — but a single merge can
   span many runs. Attribute to the merge day / project; don't double-count.
   Confirm `--no-merges` vs counting the merge commit's diff.
3. **Charting library.** Recharts (recommended — themeable, declarative) vs visx
   (more control, more code). Confirm the pick at implementation; both are *real*
   libraries — no hand-rolled SVG, no aesthetic-fighting dashboard kits.
4. **Retention.** Keep `metrics_daily` forever (it's tiny — one row per
   date×project×metric) or cap? Lean: keep (rebuildable anyway).
5. **Granularity.** Daily rollups → daily/weekly/monthly charts by aggregation. Is
   hourly ever needed? (Lean: no — daily is the operator's cadence.)
