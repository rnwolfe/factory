---
id: task-047
title: Guarantee deps installed in fresh worktree before quality checks
status: ready
priority: med
estimate: small
created: 2026-06-20T05:01:00.000Z
updated: 2026-06-20T05:01:00.000Z
labels:
  - audit
  - quality
---

## Source

Prod-usage audit (14d ending 2026-06-20). Finding F5. See `tasks/audit-prod-14d-2026-06-20.md`.

## Operator's note

Quality checks flip false-red on otherwise-clean runs because the per-run
worktree never had `bun install` run, so `tsc` can't resolve `bun-types`.

## Evidence

≥5 runs on the live host with `quality_report` typecheck `exitCode 2`:

- mabel `s6czgkz`, `f1ocbeguf6`, `x1ee46vt` — `error TS2688: Cannot find type
  definition file for 'bun-types'`.
- backbar `h6i49rxy`, `t5z4nsdv` — `Cannot find type definition file for 'bun'`.
- The long codex run `t722xnwh` hit the same mid-run and self-recovered by
  running `bun install`.
- Separately, one run (backbar `t5fbqlb6`) failed quality with
  `ENOENT: no such file or directory, posix_spawn 'sh'` loading quality.yaml.

These are environment flakes, not code defects — they pollute the (informational)
quality signal and erode trust in it.

## Agent's draft

In the quality runner (`apps/daemon/src/workers/quality.ts`) or the worktree
setup it runs in (`packages/runtime/src/worktree.ts`): ensure dependencies are
installed before invoking the project's quality commands. Options, cheapest first:

1. If `node_modules` is absent (or `bun-types`/`bun` is unresolvable) in the
   worktree, run `bun install --frozen-lockfile` once before the checks.
2. Prefer reusing/symlinking the project workdir's `node_modules` into the
   worktree when the lockfile matches, to avoid repeated installs.

Also investigate the `posix_spawn 'sh'` quality.yaml load failure — the runner
must spawn checks with a valid shell/cwd even in a bare worktree.

## Acceptance

- A fresh per-run worktree has resolvable bun types before `make typecheck` /
  the project's quality commands run; no more `TS2688 bun-types`/`bun` false-reds
  attributable to missing install.
- The quality runner can load `quality.yaml` and spawn checks in a bare worktree
  without `ENOENT posix_spawn 'sh'`.
- No measurable regression in run setup latency for projects that already had a
  populated worktree (don't reinstall when not needed).
