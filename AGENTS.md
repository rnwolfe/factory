# Factory — repo guide for Claude sessions

This file is the on-arrival orientation. Read `docs/spec.md` once before any
non-trivial change; come back here for conventions. For v0.2 work, also read
`docs/spec-v0.2.md` and `docs/adr/002-plan-primitive.md`. For v0.3 work, also
read `docs/spec-v0.3.md` and `docs/adr/003-audit-primitive.md`. For v0.4 work,
also read `docs/spec-v0.4.md` and `docs/adr/004-audit-cadence.md`. For desktop
UX work, also read `docs/desktop-spec.md` and `docs/adr/005-responsive-shell.md`.
For GitHub Issue backend / bot-identity work, also read
`docs/spec-github-issues.md` and `docs/adr/007-github-issue-backend.md`.

- **v0.1 spec:** [`docs/spec.md`](./docs/spec.md) — frozen.
- **v0.2 spec:** [`docs/spec-v0.2.md`](./docs/spec-v0.2.md) — implementation-ready delta. Plan primitive + quality signal. Shipped.
- **v0.3 spec:** [`docs/spec-v0.3.md`](./docs/spec-v0.3.md) — implementation-ready delta. Audit primitive + Path-B unlock + tier-aware onboarding. Shipped.
- **v0.4 spec:** [`docs/spec-v0.4.md`](./docs/spec-v0.4.md) — implementation-ready delta. Audit cadence (schedule layer on the audit primitive).
- **Desktop UX spec:** [`docs/desktop-spec.md`](./docs/desktop-spec.md) — Vercel-style chrome layered over the phone-first PWA. Phased migration; mobile invariant explicit. Foundation for the Tauri wrapper (#1).
- **Post-v0.1 direction:** [`docs/vision.md`](./docs/vision.md) — what's next, informed by living with each release.
- **Milestone playbook:** [`docs/handoff.md`](./docs/handoff.md) — historical, kept for context.
- **ADRs:** [`docs/adr/`](./docs/adr/) — non-obvious decisions. ADR-002 underpins v0.2 (plans). ADR-003 underpins v0.3 (audits). ADR-004 underpins v0.4 (audit cadence). ADR-005 underpins the desktop UX initiative (one Shell, responsive).

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
bun run test         # tests across workspaces (per-package, each with its own env)
```

Use `bun run test`, not bare `bun test`, as the suite gate. `bun run test` is
`bun run --filter '*' test`, so each workspace runs in its own dir and picks up
its own `bunfig.toml` — notably the PWA's happy-dom `[test].preload`, without
which every React component test fails with `document is not defined`. Bare
`bun test` from the repo root globs all workspaces into one runner and skips
those per-package preloads, producing phantom DOM failures.

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
- **Audits are read-mostly. Audits never auto-merge code.** v0.3 adds the audit primitive (`apps/daemon/src/audits/`). Audits produce reports → reports promote to plans or bugs → plans freeze and drive runs → runs auto-merge per v0.1. The audit primitive is upstream of the run primitive; never inverted. Audit skills live in the project repo at `<project>/.factory/audits/<name>/SKILL.md`. Approved audit reports get committed to the project repo at `docs/internal/audits/`.
- **Per-project artifacts are repo-canonical, not Factory-canonical.** Audit skills, approved audit reports, vision docs, AGENTS.md, task files all live in the project repo. Factory's DB rows index them for fast queries; if the DB is wiped, project value is preserved. Single-point-of-truth modules per artifact: `apps/daemon/src/projects/tasks.ts` (task IO), `apps/daemon/src/projects/audit-skills.ts` (skill loading), `apps/daemon/src/audits/report-commit.ts` (report writes). Future swap to remote storage (GitHub Issues, beads, gist, etc.) is a one-file change at each seam.
- **AGENTS.md is the agent's reading list, not a magic prepend.** Factory does not auto-inject doctrine into prompts. Runs read AGENTS.md as their operating manual; the agent loads VISION.md, prior audit reports, etc. by following references in AGENTS.md. When v0.3 ships VISION.md (project_vision freeze), the project's AGENTS.md gains a reference. The agent does the rest. `CLAUDE.md` is kept as a symlink to `AGENTS.md` so Claude Code's automatic loader still finds it — Codex (and any harness following [agents.md](https://agents.md)) reads `AGENTS.md` directly. Single source of truth, no drift. Writers (`apps/daemon/src/projects/import-spec.ts`, `apps/daemon/src/plans/apply-project-vision.ts`) target `AGENTS.md` and create the `CLAUDE.md` symlink alongside; readers (`apps/daemon/src/plans/iterate.ts`, `apps/daemon/src/audits/prompts.ts`) prefer `AGENTS.md` with `CLAUDE.md` as fallback for projects bootstrapped before this convention.
- **Tier is meaningful from v0.3 forward.** Tier (`tinker | personal | share | productize`) gates onboarding depth, default audit installation, and the `feature_plan` vision filter. `tinker` projects skip ceremony; `personal+` projects get vision + lightweight audits; `share`/`productize` get the full treatment. Tier is editable from the project header (TierPicker).
- **feature_plan vision filter is a freeze precondition.** For `feature_plan` plans on tier ≥ personal, all four `visionFilter.{identity,principle,phase,replacement}.passes` must be true. Tinker projects skip the gate. The four tests are copied from forge's `/product` skill — they are *the* mechanism keeping scope creep out of personal+ projects, so don't loosen them casually.
- **Plan supersession over plan deletion.** When a frozen plan is replaced by a newer plan in the same kind+target, the prior plan transitions to `status='superseded'` with a `supersededBy` pointer. Audit trail preserved. project_vision plans on a project form a chronological architectural diary via this chain.
- **Narrow your `bun test` scope when running under a Factory run.** Wide-scope invocations (`bun test apps/daemon/`, `bun test apps/daemon/ packages/`, `bun --filter '@factory/daemon' test`, and the full-suite gate `bun run test`) reproducibly kill the parent `claude --print` process within ~5 seconds of starting — the run ends with no `factory-status` footer and is marked `failed` even though work was committed. Smoking gun: the daemon test suite spawns child processes, HTTP daemons, and tmux sessions, and one of those teardowns disturbs the parent's tmux session. Run typecheck (`bun run typecheck`) and biome (`bun run check`) freely — those are fine. For tests, prefer single files (`bun test apps/daemon/test/foo.test.ts`) or, when you need broader confidence, run the same file groups serially in separate Bash calls rather than one wide sweep. If you must verify the full suite, do it locally outside Factory and report your status with the verbatim pass count. Tracked separately as a Factory-side bug; this is the operational workaround until the root cause is fixed.
- **Fused {agent, model} on the project; codex auth is operator-managed.** `projects.agent` ∈ {`claude-code`, `codex`} pairs with `projects.model` to form one inheritance unit. Resolution chain at run-submit: `input → task.frontmatter → project → settings → "claude-code"`. The PWA exposes both axes through `AgentModelPicker` (`apps/pwa/src/components/model-picker.tsx`); model options switch per agent because codex and claude have disjoint model ids. Codex uses the operator's ChatGPT subscription via `~/.codex/auth.json`, written once by `codex login` — see [README §"Using codex"](./README.md) and [`docs/adr/006-codex-harness.md`](./docs/adr/006-codex-harness.md). Submit-time precheck in `apps/daemon/src/workers/submit.ts` refuses codex runs when auth is missing or when the run path needs session-resume (intervene-resume / reuse-worktree) — codex has no `--resume` equivalent. `factory doctor` surfaces the auth status when codex is configured anywhere.

## Where things live

- tRPC routers: `apps/daemon/src/routers/` (`ideas`, `decisions`, `plans`, `projects` (with nested `tasks`), `runs`, `rubrics`, `audits`).
- Worker / run executor: `apps/daemon/src/workers/runner.ts`, `submit.ts`. Quality checks: `quality.ts`.
- Triage orchestration: `apps/daemon/src/triage/orchestrate.ts`. Plan iteration: `apps/daemon/src/plans/{iterate,bootstrap-from-plan,refine,apply-feature-plan,apply-project-vision}.ts`. Prompts in `prompts/`.
- Audits: `apps/daemon/src/audits/{iterate,exec-iterate,findings,prompts,promote,report-commit}.ts`. Skill loader: `apps/daemon/src/projects/audit-skills.ts`. Default templates: `docs/audit-skill-templates/`.
- Project bootstrap: `apps/daemon/src/projects/bootstrap.ts`. Task IO: `tasks.ts` (single point of truth for task creation; `createTask` consumed by bootstrap, refinement-freeze, feature-plan-freeze, finding-promote-bug).
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

## When to suggest a release

After any commit-batch that is a coherent unit of operator-visible change, suggest invoking the release skill (`skills/release/SKILL.md`). The Factory daemon installed via `factory install` upgrades on `factory upgrade --channel=stable`, which only sees released tags — so without periodic releases, the live host drifts arbitrarily far behind the dev checkout and the upgrade story stops working.

Concretely, suggest a release after:
- A merged side-cuts batch (or larger).
- Any meaningful bugfix that operators on the stable channel would benefit from — not the same as "every fix"; gauge whether someone running `factory upgrade` next would hit the bug.
- Any breaking schema or contract change. These need a release boundary so operators can pause at a known-good sha before crossing.

Do **not** suggest releases for:
- Docs-only changes that don't touch operator-facing surface (e.g. an internal ADR).
- Refactors with no observable diff.
- Internal tooling changes that don't reach the operator (`bun run cli:install`, biome config tweaks, etc.).

When in doubt, name the operator-visible delta and let the operator decide. ("This batch added a `factory upgrade` command — worth cutting v0.5.0?")

The release skill handles the version bump, changelog generation, annotated tag, and prints the push commands. **Do not push tags yourself** — that's an operator-authorized action. The skill stops at "here are the commands; you run them."

`channel: stable` resolves the highest `v*.*.*` tag on origin; channel resolution skips pre-release identifiers (e.g. `v1.2.0-rc.1`). If the release isn't ready for the stable channel yet, leave the tag off — operators on `nightly`/`dev` will still pick the change up at the next upgrade.

- **VISION.md** lives at `docs/internal/VISION.md` — read it before any non-trivial change. It states identity, principles, phases, and out-of-scope items.
