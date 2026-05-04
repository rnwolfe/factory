# Factory — repo guide for Claude sessions

This file is the on-arrival orientation. Read `docs/spec.md` once before any
non-trivial change; come back here for conventions. For v0.2 work, also read
`docs/spec-v0.2.md` and `docs/adr/002-plan-primitive.md`. For v0.3 work, also
read `docs/spec-v0.3.md` and `docs/adr/003-audit-primitive.md`.

- **v0.1 spec:** [`docs/spec.md`](./docs/spec.md) — frozen.
- **v0.2 spec:** [`docs/spec-v0.2.md`](./docs/spec-v0.2.md) — implementation-ready delta. Plan primitive + quality signal. Shipped.
- **v0.3 spec:** [`docs/spec-v0.3.md`](./docs/spec-v0.3.md) — implementation-ready delta. Audit primitive + Path-B unlock + tier-aware onboarding.
- **Post-v0.1 direction:** [`docs/vision.md`](./docs/vision.md) — what's next, informed by living with each release.
- **Milestone playbook:** [`docs/handoff.md`](./docs/handoff.md) — historical, kept for context.
- **ADRs:** [`docs/adr/`](./docs/adr/) — non-obvious decisions. ADR-002 underpins v0.2 (plans). ADR-003 underpins v0.3 (audits).

## Quick orient

- Bun workspaces: `apps/daemon`, `apps/pwa`, `packages/{runtime,db,shared}`.
- Single daemon process (Bun + tRPC + WebSocket + worker pool). PWA is a static SPA served by the daemon.
- SQLite at `~/.factory/data.db`; project workdirs at `~/.factory/projects/<slug>`; per-run worktrees at `~/.factory/worktrees/<slug>/<runId>` (kept off the project root so `git status` stays clean).
- Config: `~/.factory/config.yaml` (mode 600), `auth.token` is the bearer.

## Dev loop

```sh
bun install
bun run dev          # daemon + PWA in parallel
bun run typecheck    # all packages
bun run check        # biome (lint + format)
bun test             # bun test across workspaces
```

Per-package: `bun --filter '@factory/<name>' <script>`. DB scripts: `bun run db:generate` / `db:migrate` / `seed`.

## Conventions in use

- **No npm.** Bun for everything (install, scripts, test runner).
- **Biome over ESLint/Prettier.** `bun run check` before committing.
- **Conventional commits, small.** Branch per concern; PR-style merges (`--no-ff`) once a thread is coherent.
- **No external CI services for v0.1.** Local-only.
- **ADR for non-obvious calls.** `docs/adr/NNN-title.md`.
- **Migrations are checked in.** Generate via Drizzle Kit; never hand-edit.
- **Frontend aesthetic is load-bearing.** Dispatcher's-console: warm-dark `#0a0908`, amber accent, Fraunces/Geist/Geist Mono, dense rows, chips not pills, no shadcn defaults. Use the `frontend-design` skill when adding screens.

## Architectural contracts (don't break casually)

- **factory-status footer.** Every code-changing run wraps the prompt with a footer requiring the agent to emit a fenced JSON block declaring `done | blocked | failed`. Parser is `apps/daemon/src/workers/factory-status.ts`. **Null parse → run marked `failed`** — never silently `completed`. Do not weaken this contract; it is the only thing keeping the agent honest about completion.
- **Auto-commit before listing commits.** `packages/runtime/src/runtime.ts` runs `commitAllChanges` over a dirty worktree before computing the run's commit list. Without this, agents that wrote files but didn't commit produced empty `factory/run-*` branches.
- **WS channel split.** `/ws/events` carries structured events (parsed); `/ws/pane` carries raw bytes for xterm.js; `/ws/inbox` carries decision/idea events. Pane bytes never enter the persisted `events` table — see ADR-001 §"raw stream event".
- **Triage runs outside `runtime.spawn`.** `apps/daemon/src/triage/orchestrate.ts` pipes directly to `claude --print`. No worktree, no tmux. `runtime.spawn` is for code-changing runs only.
- **Per-run dedicated branch under `head` strategy.** Runs get `factory/run-<runId>` worktrees even when `head`-strategy is asked for; concurrent runs against one project would otherwise collide. See ADR-001.
- **Successful runs auto-merge to `main`.** `runner.ts` calls `mergeIntoMain` (`--no-ff`) after `status="completed"`. Without this, the project's `main` never moves past bootstrap and auto-advance can't compound. On merge conflict the merge is aborted, the failure is recorded in the run summary, and auto-advance is held — the operator resolves manually. Branches stay on disk regardless.
- **Worker pool default = 4.** Concurrency is real; the UX must reflect "what's running" coherently (active run vs ready task vs done task). See `apps/pwa/src/routes/project-detail.tsx` for the canonical pattern.
- **`--dangerously-skip-permissions` on code-changing runs.** Runs are non-interactive; the per-run worktree is the isolation boundary, not the CLI permission gates. Triage doesn't get this flag (different code path). When a real sandbox lands, the flag goes away. See `docs/vision.md` §5.
- **Plans are first-class, not a sub-stage.** v0.2 introduces the Plan primitive (`project_spec`, `task_plan`, `refinement`, reserved `feature_plan`). Triage approve no longer bootstraps directly — it creates a drafting `project_spec` plan in the inbox; the project materializes when that plan freezes. Plan iteration runs through `apps/daemon/src/plans/iterate.ts` (same pattern as triage: `claude --print`, fenced JSON, null-parse-fail discipline). See `docs/spec-v0.2.md` and ADR-002.
- **Quality is informational, not a gate.** Code-changing runs invoke `runQualityChecks` (`apps/daemon/src/workers/quality.ts`) after the agent's auto-commit and before `mergeIntoMain`. Failures land in `runs.quality_report` and surface in the live pane, but **do not block the merge** — gating is v0.3. The per-project config lives at `<project>/.factory/quality.yaml`; missing/empty config means "no checks for this project."

## Where things live

- tRPC routers: `apps/daemon/src/routers/` (`ideas`, `decisions`, `plans`, `projects` (with nested `tasks`), `runs`, `rubrics`).
- Worker / run executor: `apps/daemon/src/workers/runner.ts`, `submit.ts`. Quality checks: `quality.ts`.
- Triage orchestration: `apps/daemon/src/triage/orchestrate.ts`. Plan iteration: `apps/daemon/src/plans/{iterate,bootstrap-from-plan,refine}.ts`. Prompts in `prompts/`.
- Project bootstrap: `apps/daemon/src/projects/bootstrap.ts`. Task IO: `tasks.ts`.
- Workdir snapshot (file tree, git status, commits): `apps/daemon/src/projects/workdir.ts`.
- Runtime: `packages/runtime/src/{runtime,worktree,tmux}.ts`; agent providers in `agents/`.
- Schema + migrations: `packages/db/src/schema.ts`, `migrations/`.
- PWA routes: `apps/pwa/src/routes/`. Shared components: `components/`. tRPC client: `lib/trpc.ts`.

## Operator-side facts

- Single operator. The decisions inbox is the only attention sink. If you're tempted to add another one, ask why first.
- Phone-first. Every screen must work on a 390px viewport before desktop polish.
- Auto-advance is on by default — runs chain through ready tasks until one fails or the queue empties. Per-project toggle.
- Per-project Claude model is selected on the project (and at decision-approve time). `null` lets the CLI pick its own default.

## What v0.1 promised vs. what's deferred

See `docs/vision.md` for the lived-experience refresh. The original §13 backlog in `spec.md` still applies; the vision doc reorders priorities based on what actually frustrated the operator during v0.1 use.
