# Changelog

All notable changes to Factory are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## v0.12.4 — 2026-05-26

### Fixed
- **Codex model picker refreshed against the current codex CLI.** The
  hardcoded `gpt-5` / `gpt-5-codex` entries were stale — they no longer
  appear in codex 0.133.0's own model cache, and codex's internal
  migration table even maps `gpt-5.2-codex → gpt-5.3-codex → gpt-5.4`.
  Picker now lists `gpt-5.5` (frontier), `gpt-5.4` (everyday),
  `gpt-5.4-mini` (fast/cheap), and `gpt-5.3-codex` (codex-tuned). Source
  of truth comment now points at `~/.codex/models_cache.json` so future
  refreshes have an authoritative list to check.

## v0.12.3 — 2026-05-26

### Fixed
- **Settings → default model now offers the agent axis.** The backend has
  accepted a `default-agent` setting since the codex harness shipped, but
  the settings page only rendered the legacy claude-only `ModelPicker`,
  so operators couldn't pick codex (or any codex model id) as the system
  default. Swapped in `AgentModelPicker`; switching agent resets the
  model selection to "default" so a stale claude model id doesn't ride
  into a codex run by inheritance.

## v0.12.2 — 2026-05-26

### Changed
- **AGENTS.md is now the canonical agent-instruction file.** Standardizing
  on the [agents.md](https://agents.md) open convention so Codex (and any
  other harness following it) reads the same operating manual as Claude
  Code. `CLAUDE.md` lives on as a symlink to `AGENTS.md` so Claude Code's
  automatic loader still finds it — one source of truth, both harnesses
  see identical content, no duplication or drift. Writers (spec-import
  bootstrap, project_vision freeze) now lay down `AGENTS.md` + the
  `CLAUDE.md` symlink for new projects; readers (plan iteration, audit
  context-gathering) prefer `AGENTS.md` and transparently fall back to a
  legacy regular-file `CLAUDE.md` for projects bootstrapped before this
  convention. Existing managed projects keep their `CLAUDE.md` — the new
  reader handles them, and the symlink helper will migrate them safely on
  the next vision-freeze.

## v0.12.1 — 2026-05-25

### Changed
- **CLAUDE.md narrow-`bun test` contract.** Agents running under Factory
  are now told to scope `bun test` to single files or single workspaces
  and avoid the wide-scope invocations (`bun test apps/daemon/`, `bun
  --filter '@factory/daemon' test`) that have reproducibly killed the
  parent `claude --print` process within ~5 seconds of starting. Four
  consecutive task-020 attempts died this way before the retry-in-worktree
  path (which lets the agent verify on already-committed work) cleared
  the task. Root-cause hunt deferred; this is the operational workaround.

## v0.12.0 — 2026-05-25

In-app release notes. The next upgrade greets the operator with a
bottom-sheet showing what's new; settings gains a permanent entry point
to the full history.

### Added
- **Auto-opening release-notes sheet.** Once per release, on the first
  authenticated view after an upgrade, a dismissible bottom-sheet
  renders the latest `CHANGELOG.md` entry (bold lead-ins styled, sections
  preserved). localStorage tracks the last-seen version so fresh installs
  silently record the current version instead of opening against an
  empty history. Esc, the "got it" button, or backdrop dismissal closes
  it and writes the current version back.
- **Release-notes history viewer** at `/settings/release-notes`. The
  full parsed `CHANGELOG.md` rendered as stacked cards, newest-first.
- **Settings → about → release notes** entry, showing the build's
  `__FACTORY_VERSION__` next to a link to the history viewer — re-open
  path for anyone who dismissed the sheet too quickly.
- **`changelog.latest` / `changelog.all` tRPC queries.** Backed by a
  pure markdown parser (5 unit tests pinning bold-lead bullets,
  multi-entry, no-date, continuation lines, empty file). The loader
  walks up from cwd to find `CHANGELOG.md` — `bun run --filter` chdirs
  into the workspace dir before invoking, so `process.cwd()` isn't the
  repo root.

## v0.11.0 — 2026-05-25

Retry-in-worktree affordance for blocked/failed runs, codex agent harness
spike (subscription-auth CLI wired through every headless invocation path),
and a 30-day spend sparkline on the project detail view. Two run-page
empty-events fixes that surfaced after the May 23 pane refactor.

### Added
- **Retry-in-worktree on blocked/failed runs.** Run detail view has a
  retry button that re-spawns the agent on the prior worktree (preserving
  any auto-committed partial work). Backend mutation `runs.retryInWorktree`
  enforces failed-or-blocked only, verifies the source worktree still
  exists, and stamps the new run with `retry_of_run_id` so the chain is
  queryable. Runtime gains a `requireExistingWorktree` guard on `spawn`
  so the retry path attaches to the existing branch instead of trying to
  recreate it.
- **Codex agent harness.** New `codex` agent provider in
  `packages/runtime/src/agents/` wraps the codex CLI under ChatGPT
  subscription auth (no API key needed). Agent dispatch is wired through
  every headless invocation site — runner, plans, audits, triage,
  deferred-tasks — so any code-changing path can run on either claude or
  codex. Five follow-up tasks from the parent feature plan are queued.
- **30-day spend sparkline.** Project detail page shows a collapsible
  strip with daily cost/tokens trends.
- **Metrics URL state.** `range` and `groupBy` controls on the metrics
  view persist via URL params — reload-friendly and shareable.

### Fixed
- **Run-page empty events on revisit.** Two related bugs in
  `apps/pwa/src/routes/run.tsx`: react-query was serving a stale empty
  array via `gcTime: 0` mishandling, and the tRPC `runs.diff` payload
  shape change wasn't being unwrapped. Now uses an `isFetching` guard and
  the corrected diff payload.

## v0.10.6 — 2026-05-24

Session-pane fixes. Three real bugs that all trace back to the same
oversight in commit f363bbe (May 23) — that commit added the binary-
vs-text WebSocket frame split + resize forwarding to `live-pane.tsx`
but forgot to mirror the same updates to `session-pane.tsx`.

### Fixed
- **Interactive shell sessions accept typing.** session-pane was
  sending keystrokes as `ws.send(string)` → text frames; the
  daemon's pane handler treats text frames as JSON control envelopes
  and silently drops on parse failure, so every keystroke was
  discarded. Encode to bytes via `TextEncoder` like live-pane does.
- **Session pane resizes tmux to match xterm grid.** session-pane
  was fitting xterm to the visible container but never forwarding
  the new dims; tmux stayed at its 80x24 spawn default, the inner
  shell saw a phantom grid, status lines clipped, large swaths of
  dead space appeared in the pane. session-pane now wires
  `term.onResize → sendResize` with a resync on WS open and an
  `orientationchange` listener (iOS rotation parity).
- **xterm cell-grid alignment + glyph rendering.** Box-drawing
  characters were duplicating / mis-aligning because
  `lineHeight: 1.25` broke xterm's cell-row math. Dropped to `1.0`.
  Widened the font stack to prefer Nerd Font Mono variants
  (`Hack`, `MesloLGM`, `FiraCode`, `JetBrainsMono`) first so
  terminal-program icons render when the operator has a Nerd Font
  installed on the client. Geist Mono remains the no-Nerd-Font
  fallback.

### Removed
- Diagnostic `[pane]` console.log lines added in v0.10.5 (an
  internal debug-only release). Bug found, instrumentation reverted.

## v0.10.4 — 2026-05-24

Hot-fix on v0.10.3.

### Fixed
- **Interactive shell sessions accept typing again.** v0.10.3 set
  `macOptionIsMeta: true` on the live + session xterm panes to make
  Option-key chords reach neovim as Esc+key, but it broke basic
  typing input in interactive sessions. Reverted on both panes until
  we can reproduce + understand the interaction. The Cmd/Ctrl+K
  focus-gate from v0.10.3 (separate change, only affects the command
  palette chord) stays — it's clearly scoped and the right behavior.
  `<M-…>` neovim maps remain non-functional until this is properly
  resolved.
- **Metrics page typechecks.** Defensive optional-chaining on
  `series[si]` access in the stacked-bar render (TS strict-mode
  caught the unguarded index access after the v0.10.3 metrics
  range-chart change).

## v0.10.3 — 2026-05-24

Reliability + observability fixes around task-status propagation,
plus a small terminal-UX cut.

### Added
- **Shared `workers/post-merge.ts` helper** centralizes auto-advance
  + defensive task-status reconcile across three call sites
  (runner happy path, `decisions.ts` merge_failure approve,
  `interventions/orchestrate.ts` finalizeMergeFailureResume). Helper
  is idempotent and guards against double-fire auto-advance when
  another run on the same project is already queued/running. Tested
  via `merge-failure-approve.integration.test.ts`.
- **Keyboard chords cede to focused xterm panes** so terminal-app key
  sequences (vim, less, etc.) pass through the live-pane without the
  PWA hijacking them.

### Fixed
- **factory project task-status was silently stuck at `ready`.** The
  factory project's `.gitignore` blanket-ignored `.factory/`, so the
  runner's pre-merge `chore: task-NNN status -> done` commit picked
  up zero files and silently no-op'd. Replaced the blanket with
  `.factory/runs/` (the inner `.factory/.gitignore` already covered
  this), making `work/`, `audits/`, `meta.yaml`, and `notes/`
  trackable. Back-filled the 7 historically-stuck task statuses
  (001, 006, 007, 008, 009, 010, 015). Going forward the post-merge
  helper's reconcile actually lands.
- **Empty task-status commit now logs a warning.** Both callsites
  (runner pre-merge + post-merge.ts reconcile) check
  `commitAllChanges`' return value and log a clear warning naming
  the task, workdir, and likely cause (gitignored `.factory/work/`).
  Surfaces in `journalctl --user -u factory` so the next instance
  of the gitignore trap is visible on first occurrence instead of
  accumulating silently-wrong statuses.

## v0.10.2 — 2026-05-24

Small follow-up to v0.10.1's per-task model picker: the override is
now visible at a glance from the project's tasks list, not only on
the per-task detail page.

### Added
- **Model chip on tasks-list rows.** When a task has a `model:`
  override set, the project page's task row shows a compact chip
  (`opus` / `sonnet` / `haiku`, or the trailing segment of any other
  model id). No chip when the task inherits from project default —
  the common case stays uncluttered.

## v0.10.1 — 2026-05-24

Cost-discipline release ahead of Anthropic's 2026-06-15 Agent SDK
billing change. `claude --print` (Factory's path) moves to a separate
$/credit pool then — Max 5x gets $100/mo, Max 20x gets $200/mo, billed
at API list prices above the credit. Stretching that credit means
running cheaper models where they're enough; this release makes that
practical.

### Added
- **Per-task model override.** Task frontmatter (`model:`) pins a task
  to a specific Claude model id. Surfaced via a ModelPicker on the
  task-detail page and in the "+ task" modal. The `+ task` route on
  the project page now accepts a model override at creation.
- **System-level default model setting (`default-model`).** New row in
  settings → dashboard. Falls into the inheritance chain at the
  bottom: `task.model → project.model → settings.default-model → CLI
  default`. Empty = CLI picks. Settings UI uses the same ModelPicker.
- **`runs.model` column** captures the effective model at submit time
  per the inheritance chain. Stable across later upstream changes —
  resume/retry/metrics views can always show what the run was actually
  invoked with.
- **Ticker + `/ops` rewrite around dollars + tokens.** Three
  calendar-aligned windows: today (since local midnight), this week
  (since Monday 00:00), this month (since the 1st). Each shows cost
  and ↑input/↓output tokens. The monthly window matches Anthropic's
  Agent SDK credit reset cycle.

### Removed
- **Usage cap settings (session/weekly/daily) and the API key field.**
  Shipped in v0.10.0 but unused: the % meters they fed are gone; the
  API key was a stub for org-usage polling that turns out to be
  measuring the wrong thing after 2026-06-15. Setting keys removed
  cleanly; existing prod rows (if any) are inert.

### Migration note
v0.10.1 includes migration `0023_run_model` adding `runs.model`. The
SQL file was hand-written (drizzle-kit needs a TTY which isn't
available from the agent's session) — the migration applies cleanly,
but `meta/0023_snapshot.json` is missing. Regenerate snapshots when
you next add a schema column by running `bun run db:generate` from a
terminal; drizzle-kit will rebuild the snapshot chain.

## v0.10.0 — 2026-05-24

The operational-awareness release. After weeks of living with the
decisions-only inbox, the operator wanted a separate surface for "what
is happening right now" — running agents, current Claude usage, recent
activity per project — without competing with the inbox for attention.

Two new surfaces, both opt-in:

- A compact ticker in the app shell shows `N running · ↑in ↓out · $today`
  plus rolling cap %s when caps are configured. Always visible, never
  badges/animates aggressively; tap-through to `/ops` for the full
  picture.
- A dedicated `/ops` route renders usage cards (today / rolling 5h /
  rolling 7d), running runs, queued runs, active intervene sessions,
  and the last 24h of terminal activity.

The inbox-as-attention-sink contract is preserved: the ticker is
ambient (no badges that demand action), `/ops` is opt-in (operator
visits when they want), and the inbox stays at `/` by default. An
operator who prefers `/ops` as their home can set it from the new
"dashboard" section of settings.

### Added
- **`ops.snapshot` tRPC query** aggregates live runs, queued runs,
  recent terminal activity (24h), active sessions, and three rolling
  usage windows (today / 5h / 7d) from `claude_metrics`. Single
  endpoint so the dashboard sees a consistent view.
- **New `ops` WS scope** on `/ws/events` matches run-activity events,
  so the ticker and `/ops` page invalidate live as runs come and go.
- **Dashboard ticker** in the app shell (compact on desktop, single-
  line below the header on mobile). WS-driven; 30s polling backstop.
- **`/ops` route** with usage meter cards (% when caps configured;
  absolute otherwise), running/queued/sessions/recent run lists.
- **Landing route setting** lets the operator pick `/inbox` or `/ops`
  as the page that opens at `/`. Inbox stays the default.
- **Three usage caps** in settings (`usage-cap-session-tokens`,
  `usage-cap-weekly-tokens`, `usage-cap-daily-usd`). When set, the
  ticker and `/ops` show % meters; empty disables that meter.
- **Anthropic API key field** in settings — stored verbatim, redacted
  at the router boundary. Stub for future org-usage polling; not yet
  used by any path. Claude subscription (Pro/Max) usage and API-keyed
  org usage are separate billing surfaces — wiring up the key for
  subscription users won't necessarily improve % accuracy. Operators
  on subscription should rely on cap-based % from our own metrics.

## v0.9.8 — 2026-05-24

Adhoc task capture per project. The idea → triage → plan pipeline is
correct for "should we do this?" but pure friction when the operator
already knows. The "+ task" button on each project page is the fast
path: describe the bug/feature, optionally run it immediately, done.

### Added
- **"+ task" button on project page.** Header gains a `+ task` action
  next to `feature plan`/`deepen`/`code`. Opens a modal with title,
  kind chips (bug/feature/refactor/docs/other), priority chips, and
  an optional body. A "run immediately after creating" toggle goes
  one further: the task is created and a run is submitted in the
  same gesture, with the operator dropped onto the run-detail page.
  Routes through the existing `projects.tasks.create` endpoint, so
  storage is single-pointed and behavior matches every other
  task-creation path (bootstrap, refinement-freeze, audit-promote).

## v0.9.7 — 2026-05-24

`factory prune` for one-shot worktree-backlog cleanup. Pairs with the
v0.9.6 auto-cleanup that prevents new accumulation: prune handles the
historical pile the operator already has.

### Added
- **`factory prune` CLI command.** Lists candidate worktrees for
  terminal-status runs and removes them with `--apply`. Dry-run by
  default. Default targets only `completed` runs (already merged into
  main, safest); `--include-failed` broadens to
  failed/blocked/aborted/usage_capped/deferred. `--project=<slug>`
  scopes to one project; `--age=<days>` filters by run end time.
  Branch refs are preserved either way — `git log <branch>` still
  works for inspection, and the blocked-run retry path still
  fast-forwards from the branch tip.

  Running/queued runs are never touched — the SQL filter excludes
  them. Best-effort: falls back to `rm -rf` + `git worktree prune`
  when `git worktree remove` refuses (e.g., dirty worktree, manual
  rm broke the registry).

## v0.9.6 — 2026-05-24

Worktrees no longer accumulate forever. The runtime's prior cleanup
only triggered on `commits.length === 0` — any run with even one
commit kept its worktree on disk. After weeks of use the worktrees
dir becomes the largest thing in `~/.factory` (2GB+ is common).

### Added
- **Auto-cleanup worktree on successful merge.** When a run merges
  into main cleanly, the runtime removes the worktree directory.
  The branch ref is preserved — `git log <branch>` still works for
  inspection — and any failed/blocked run's worktree is untouched so
  the operator can still investigate. Best-effort: a failed cleanup
  logs a warning but doesn't fail the run.

### Migration note
Existing backlog of worktrees from earlier completed runs isn't
auto-cleaned (we don't have a reliable signal of which were merged
under the old code path). To reclaim the disk:
```
# List, then `git worktree remove` per project, or:
rm -rf ~/.factory/worktrees/<slug>/<old-runId>
git -C ~/.factory/projects/<slug> worktree prune
```
A `factory prune` CLI command is on the roadmap for one-shot cleanup.

## v0.9.5 — 2026-05-24

Project page declutters. Tasks list no longer grows into a wall of
done/dropped rows as projects mature; runs list no longer scrolls
forever as runs accumulate. Two collapses, both opt-in to expand.

### Changed
- **Tasks split into active vs archived.** The tasks tab shows only
  live work (ready/in_progress/blocked/review) by default; done and
  dropped tasks fold behind a `show N done/dropped` toggle below.
  Section count reflects active tasks only — the matched mental model
  for "what's left to do."
- **Runs tab caps at 15 visible.** A `show N more` button reveals the
  rest (server still caps at 100). The most recent runs are almost
  always what the operator wants; the rest is history.

## v0.9.4 — 2026-05-24

Auto-advance now respects the operator's starting point. Previously,
starting task-009 and finishing it would auto-advance to task-001
(the first ready task in the list), silently undoing the operator's
"skip the early ones" intent. Now it picks the next ready task AFTER
the one that finished, and stops if nothing later is ready — the
operator can pick an earlier task manually when they want to go back.

### Fixed
- **Auto-advance respects task order.** Picks the next ready task with
  an id after the one we just finished, never wrapping back to earlier
  tasks. Falls back to the first ready task only when there's no
  recorded prior task id (ad-hoc submissions). When nothing later is
  ready, auto-advance stops instead of jumping to an earlier task.

## v0.9.3 — 2026-05-23

Run-detail "changed files" panel is no longer empty after a run merges
into main. The diff endpoint inferred its base via `git merge-base
main <branch>`, which silently returns the branch tip after a `--no-ff`
merge — making the diff `<branch-tip>..<branch-tip>` (empty). The
operator saw files live during the run but got "no changes recorded"
on any cold-load of a completed-and-merged run.

### Added
- **Runs capture their base sha at submit time.** `submit.ts` now
  resolves `input.baseRef ?? "main"` against the project workdir at
  run creation and stores the result in `runs.base_ref`. Deterministic,
  stable across later merges or rebases.

### Fixed
- **Diff endpoint returns real files for merged runs.** `runs.diff`
  prefers the run's recorded `base_ref` (sha) when present. For
  historical runs created without one, it derives the base by walking
  the events table to find the run's oldest commit and using its
  parent (`<oldest-sha>^`). The original `git merge-base` path remains
  as a final fallback for runs with neither a recorded base nor any
  recorded commits.

## v0.9.2 — 2026-05-23

`factory upgrade` no longer leaves the checkout on detached HEAD when
the operator was on a named branch. Channels are still sha pointers
internally, but the common single-host setup overlays the upgrade
checkout on a Factory project workdir, where a detached HEAD makes
`mergeIntoMain` refuse to merge run branches. Every upgrade silently
broke the next merge until the operator re-attached manually.

### Fixed
- **`factory upgrade` preserves the operator's branch.** When the
  checkout is on a named branch (commonly `main`) and the target sha
  is a fast-forward, the branch advances to the sha and HEAD stays
  attached. When the branch has local commits beyond the target, the
  upgrade falls back to detached HEAD — the local commits stay
  reachable from the branch ref. Operators whose dev clone doubles as
  a project workdir no longer need to `git checkout main` after each
  upgrade.

## v0.9.1 — 2026-05-23

Hot-fix on v0.9.0. The run-detail page hung on runs with many
agent-text events. The cause was an agent-authored, unreviewed change
that landed via a merge_failure intervention before v0.9.0: it swapped
the text renderer's `<pre>` for `<MarkdownBlock>`, reversing a
deliberate prior fix. The deleted comment was explicit about the
problem ("hundreds of agent-text events adds up to seconds of
synchronous parsing on initial paint, which can lock the main thread")
and memoization doesn't save the initial paint.

### Fixed
- **Run-detail page no longer hangs on long runs.** Reverted the
  run-event-row text renderer back to plain `<pre>`. The pane-level
  `[raw]` toggle still drops the operator into the xterm stream for
  byte-perfect debug.

## v0.9.0 — 2026-05-23

A reliability release for stuck runs. Two failure modes that previously
stranded the operator now route through the inbox cleanly.

The usage-cap detector missed the CLI's real message — it matched "hit
your limit" but the CLI was emitting "hit your **session** limit", so
real caps slipped through as generic failures with no auto-resume. The
reset-time parser also rejected the round-hour form ("resets 1am") that
the CLI uses on hourly resets. Both are widened, so the same cap that
previously had to be manually recovered now auto-resumes.

The bigger gap: runs that ended without the factory-status footer were
marked `failed` and surfaced nowhere — no inbox card, no retry button,
no operator affordance. The agent's auto-committed work sat on a
stranded branch until you went looking for it. Failed runs now create a
`blocked_run` decision the same way blocked runs do, flagged
`payload.failed = true`. Approving it submits a retry on the source
run's branch tip so the partial work rides forward.

### Added
- **Failed runs surface as decisions.** A `failed` terminal status
  (e.g. the CLI exited without writing the factory-status footer) now
  files a `blocked_run` decision with `payload.failed = true`, instead
  of stranding silently. Approve to retry — the new run branches from
  the source run's tip and picks up any auto-committed partial work.
  The inbox card and decision detail switch to a "failed run / retry"
  framing when the flag is set.

### Fixed
- **Usage-cap detection misses the CLI's real wording.** Widened
  `USAGE_LIMIT_RE` to match `hit your <word> limit` so phrasings like
  "hit your session limit" or "hit your weekly limit" trip the cap
  path instead of the generic-failure path. Without this, capped runs
  silently strand as `failed` with no auto-resume.
- **Round-hour cap reset times no longer skip auto-resume.**
  `parseUsageResetTime` accepts `resets 1am` (no `:MM`) in addition to
  `resets 12:10am`. Round-hour resets were previously unparseable,
  forcing a manual decision instead of auto-resuming at the reset
  time.

## v0.8.0 — 2026-05-17

The desktop release. Heimdall grows a real desktop UI alongside the
phone-first PWA — a responsive Shell with a sidebar, an inbox
split-view, project-detail tabs, a ⌘K command palette, and a top bar
with a project switcher — without regressing the 390px mobile layout.
The operator-visible surfaces also pick up the new name: "factory" →
"Heimdall".

The other half is reliability. Runs that hit the account usage cap now
resume automatically when the limit resets — same worktree, same Claude
session — instead of failing and being redone from scratch. A run can
no longer hang forever when the agent leaves a process holding
`claude --print` open. And quality checks delegate to a project
Makefile, so a polyglot project's gate isn't pinned to a bun toolchain
it never used.

### Added
- **Desktop UI.** A responsive Shell with a desktop sidebar, inbox
  split-view, project-detail tabs, a desktop top bar (project switcher
  + breadcrumb + ⌘K trigger), and a ⌘K command palette. The phone
  layout is unchanged; desktop is purely additive (ADR-005).
- **Usage-cap resume.** A run halted by the account usage limit is
  marked `usage_capped` (not `failed`); the daemon parses the reset
  time and auto-resumes the run — reusing its worktree and Claude
  session — once the cap lifts. When the reset time can't be parsed or
  the cap recurs, a `blocked_run` decision surfaces so the operator
  resumes on their own schedule.
- **Run-completion push.** Opt-in push notifications when a run
  finishes successfully, plus app shortcuts in the manifest and a
  Badging API count for the inbox.
- **History view.** A `/history` route surfaces actioned decisions
  (parked, trashed, dismissed), with a restore action to bring one
  back.

### Changed
- Operator-visible PWA surfaces renamed from "factory" to "Heimdall".
- Width discipline and button compaction across PWA screens so the
  desktop layout reads as designed rather than a stretched phone app.

### Fixed
- A run no longer hangs indefinitely when the agent leaves a child
  process holding `claude --print` open: the runtime force-closes the
  tmux session a grace period after `agent_exit`.
- Quality checks delegate to a project `Makefile` (`make typecheck` /
  `lint` / `test`) instead of a hard-coded bun toolchain, and a
  migration repoints projects bootstrapped before the change.
- Factory-generated commits (auto-commit, task status, merge, …) now
  use valid conventional-commit prefixes.

## v0.7.0 — 2026-05-10

The intervene-and-defer release. Two new primitives that bridge the
gaps between the agent's `claude --print` one-shot turns and the
operator's reality.

**Intervene** lets the operator jump into a stuck worktree (or a
merge-failed project tree) over tmux, fix what's wrong by hand, then
resume the *same* Claude session from where it blocked — gitignored
data and built artifacts intact. Works on `blocked_run` and
`merge_failure` decisions.

**Deferred tasks** bridge work that genuinely outlives a single
`--print` turn: long builds, multi-stage indexing, exhaustive test
runs. The agent emits a `factory-defer` block declaring a command +
self-summary + continuation prompt; Factory spawns the command as a
daemon child (not the agent's tmux pty, which dies with `--print`)
and submits a continuation run reusing the source worktree when the
work finishes. This replaces the broken pattern of agents trying to
use `ScheduleWakeup` / `Monitor` / `Bash &` under `--print`.

### Added
- **Intervene flow.** `blocked_run` and `merge_failure` decisions
  surface an "intervene" action that opens a tmux session over the
  existing worktree (no fresh checkout, so gitignored state is
  preserved). On resume, the agent's prior session is re-attached
  with the intervention notes folded into the prompt as
  operatorContext. Boot recovery marks active interventions as
  orphaned across daemon restarts.
- **Deferred-task primitive.** New `factory-defer` block protocol
  taught alongside the `factory-status` footer. `runs.status` gains
  `deferred`; new `deferred_tasks` table tracks subprocess id, log
  path, exit code, and continuation run id. PWA shows a live
  DeferredTaskPanel with status chip, log tail, cancel button, and a
  link to the continuation run. Boot recovery marks running rows as
  `orphaned` (subprocess pids may have been reparented to init).

### Fixed
- `factory upgrade` now rebuilds the CLI dist mid-flow so the next
  invocation runs the new code instead of the old binary.
- Surface per-device push-notification failures in the test push
  result so an iOS-only failure doesn't look like a generic success.
- Default VAPID subject is now a real address; boot logs warn when
  the configured subject is APNs-incompatible (e.g. `mailto:*@localhost`)
  before the operator hits a silent 403 BadJwtToken on iOS.
- Intervene-resume now reuses the source worktree+branch instead of
  branching from its tip — keeps gitignored build output and `.env*`
  files where the resumed agent expects them.
- Runtime no longer force-kills the agent's tmux 500ms after
  `agent_exit`. Lets nohup'd children survive long enough to be
  picked up by the deferred-task primitive.

## v0.6.0 — 2026-05-09

The unblock-and-survive-restart release. Blocked runs are no longer a
dead end: the operator can answer the agent's questions in a thread on
the decision and have those answers ride forward into the retry's
prompt — instead of re-running the same task and re-hitting the same
blocker. Plus two infrastructure fixes that surfaced when push
notifications failed against the live DB and an orphaned run silently
disappeared from the inbox.

### Added
- Operator reply thread on blocked_run decisions. The agent's questions
  are answered in-line; on approve (= retry), the gathered replies are
  folded into the new run's prompt as an authoritative "Operator notes"
  preamble — the agent starts with answers instead of looping back into
  the same blocker. Reuses the triage thread pattern (no new primitive),
  with non-triage copy and a soft warning when retrying with no reply.
  New `runs.operator_context` column persists the threaded answers on
  the run row.

### Fixed
- Recovered blocked runs no longer disappear from the inbox.
  `reapOrphanedRuns` (the daemon-startup salvage path that reads the
  agent's persisted log when a `running` row is found post-restart) now
  mirrors `runner.ts` and creates the matching `blocked_run` decision +
  publishes a `decision_created` event. Previously the run was flipped
  to `blocked` but no decision existed, violating the
  inbox-as-only-attention-sink contract.
- `factory upgrade`'s migrate + seed subprocesses now inherit
  `FACTORY_HOME` resolved from the systemd unit file. Without this they
  silently targeted `~/factory/data.db` instead of the live daemon's
  DB — masking missing migrations because the daemon also runs
  migrations at boot, but leaving rubric_versions and prompts seeded
  against the wrong DB. This was the root cause of v0.5.0's
  "no such table: push_subscriptions" failure on live: the seed-time
  CREATE TABLE never targeted the live DB.
- Registers the previously-orphaned `0018_push_subscriptions` migration
  in `meta/_journal.json`. The SQL file shipped in v0.5.0 but its
  journal entry was never added, so drizzle silently skipped it.
  Combined with the FACTORY_HOME fix, the next upgrade applies it
  cleanly.
- `factory upgrade` now accepts `--help`/`-h`, auto-discovers the dev
  checkout from the systemd unit's `WorkingDirectory` when
  `upgrade.checkout` isn't set, and replaces "fatal: not a git
  repository" with a directive error pointing at `factory install
  --force`.
- `doctor` and the daemon's startup banner now surface localhost-only
  binds — operators on phones won't quietly fail to reach the daemon
  because `host: 127.0.0.1` shipped in their config.
- PWA shell + auth-gate version chip now reads from `package.json`
  instead of a hard-coded string, so it stops drifting from the
  installed sha.

## v0.5.0 — 2026-05-09

The attention-surface release. The operator gets two new ways to be told
what needs them — universal agent decisions in the inbox and Web Push to
enrolled devices — plus a turbo on-ramp for projects that already have a
written spec. Also a sweep of mid-run live-pane stability fixes after
those surfaces started catching real load.

### Added
- Spec-import on-ramp. Upload an existing SPEC/plan and Factory
  scaffolds the project, stores the SPEC verbatim, decomposes it into
  runnable chunks, and is ready to execute end-to-end with auto-advance.
  No triage rubric run; the operator-supplied spec is the rubric.
- Universal mid-run decision inbox + autonomy toggle. Agents now surface
  architectural / library / scope / tradeoff calls to the inbox via a
  `factory-decision` fenced block parsed in-stream, persisted as a new
  `agent_decision` decision kind. Per-project `autonomy_mode`
  (`collaborative` | `autonomous`) silences routine surfacing on
  projects where the operator wants the agent to just decide. Stop-the-
  line events (blocked_run, merge_failure) bypass the filter.
- Multi-choice + custom-answer overrides on agent decisions. Decisions
  declare `responseType: "single" | "multi" | "free"`. The PWA renders a
  three-tab override form (agent's choice / pick option / custom) that
  on submit stamps the override into the payload, marks the decision
  actioned, and opens a refinement plan seeded with the operator's
  rationale.
- PWA push notifications. End-to-end Web Push: VAPID keypair generated
  on first daemon start and persisted to config.yaml; a new
  `push_subscriptions` table; service worker that handles `push` and
  deep-link `notificationclick`; Settings → notifications panel with
  enable / send-test / enrolled-devices list. Triggers: new decisions
  (subject to autonomy filter for `agent_decision`), audit completion,
  session merge failure. iOS Safari requires PWA-installed-to-home-
  screen; serving over LAN http won't subscribe — needs https or
  localhost.

### Changed
- Full prompts audit pass. Every prompt under `prompts/` rewritten for
  ceremony-naming consistency (`shared`/`production`), anti-confabulation
  rules, structured `decompose_questions` shapes, evidence/anchor-band
  rubric axes, full envelope per turn, vision-section caps, and
  contributor branches. Audit envelope switched to a two-block format
  (markdown report + JSON findings) to avoid brittle JSON-stringified
  markdown.

### Fixed
- Auto-merge contract was hiding run diffs. The diff endpoint computed
  `main..run.branch`, which collapses to empty after a successful run
  auto-merges to main with `--no-ff` (every run commit becomes reachable
  from main via the merge commit). Switched to
  `merge-base(main, run.branch)..run.branch` so the run's contributions
  stay visible before and after merge.
- Live-pane freeze on run-page navigation, three layered fixes:
  (1) error boundaries + memo + rAF-batched event arrivals + markdown
  source cap; (2) server-side `runs.events` payload trim (limit 400,
  text events capped at 4KB) plus client stuck-loading UI with retry
  and AbortSignal threading; (3) lazy-mount xterm — Terminal is now
  constructed only on first switch to raw view rather than on every
  LivePane mount, plain `<pre>` for event text instead of running the
  markdown tokenizer hundreds of times per paint, `MAX_EVENTS` lowered
  500 → 200, and `runs.rawLog` deferred until raw view opens.
- Daemon synthesized-config persistence. The first-start config is now
  written to disk so the auth token survives restarts (previously every
  `bun run dev` minted a fresh token and the operator had to re-paste).
- CLI dev/live host isolation — `bun run dev` and the installed daemon
  now use distinct `FACTORY_HOME` roots; `factory` CLI config writes to
  the right one.
- `factory.service` systemd unit gets an explicit `PATH` so PATH-
  dependent helpers resolve under `Type=notify`.
- `factory upgrade` fails fast with a clear message when the dev
  checkout isn't configured, instead of producing a confusing partial
  upgrade.

## v0.4.0 — 2026-05-06

The project-types release. The old single-axis `tier` enum (overlapping
awkwardly with `goal`) splits into orthogonal `ceremony × role` plus a
SPDX `license` metadata field. Triage gets five anchored rubrics keyed
on that pair instead of one. Several mobile-pane fixes round out the
shell-as-first-class-tool work.

### Added
- Project model: `ceremony` (tinker / personal / shared / production —
  renamed from `tier`), `role` (owner / contributor — new), and SPDX
  `license` metadata. Forward-only migration backfills (`share`→`shared`,
  `productize`→`production`, all existing rows default to `owner`).
- Five-rubric triage matrix: `rubric-owner-{tinker,personal,shared,
  production}` plus a single `rubric-contributor` for all upstream
  ceremonies. Each rubric carries positive/negative signals and
  per-band scoring anchors so the agent must cite specific evidence to
  score above a threshold. The contributor rubric blocks greenlight
  when `alignment_with_upstream < 6` regardless of weighted score.
- Triage prompts v2: `triage-prompt-v1` rewritten to consume
  `INTENT_CEREMONY` / `INTENT_ROLE` (replacing `GOAL_HINT`) and to
  treat anchors literally. New `triage-contributor-v1` for the
  contributor flow — the deliverable is a PR plan, not a project_spec.
- `RolePicker` chip beside `CeremonyPicker` on the project header.
  Both now close on outside-click. License auto-detected on import
  from `package.json` or LICENSE file (SPDX recognized for MIT,
  Apache-2.0, MPL-2.0, GPL-2/3, AGPL-3.0, BSD-2/3-Clause, Unlicense).
- `sessions.tail` tRPC endpoint that reads the last 128 KiB of the
  tmux pipe-pane log and replays it on session-pane mount, so PWA
  reload / revisit reconstitutes prior scrollback. Survives daemon
  restarts since the log is on disk.
- Touch-scroll handling for xterm panes: vertical swipes navigate
  scrollback (`term.scrollLines`); the keyboard only opens on real
  taps (<250ms, <8px); preventDefault stops the page shell from
  pull-to-refresh during terminal swipes. Wired into SessionPane,
  ScriptPane, LivePane.

### Changed
- `bun run dev` now seeds first (`bun run seed && ...dev`) so dev
  checkouts auto-pick up new rubrics / prompts on restart instead of
  needing a manual seed step.
- Triage refuses approval for contributor-intent ideas — the operator
  is redirected to `/projects/import` since fresh-init bootstrap
  doesn't apply when contributing to someone else's repo.
- Vision filter for `feature_plan` freezes and auto-creation of
  `project_vision` on bootstrap now require `role=owner` plus
  `ceremony ≥ personal`. Tinker projects and contributor projects
  skip vision ceremony entirely.
- Seed deactivates legacy rubric keys (`rubric-me-tinker`) not in the
  current matrix on each run, keeping the rubrics list tidy after the
  schema split.

### Fixed
- Shell session input now reaches tmux: `term.onData` is wired
  alongside terminal boot (not inside the WS effect) and routes
  through a `wsRef` so the handler survives reconnects.
- Per-character pty echo flushes immediately. `tmux pipe-pane` is
  wrapped with `stdbuf -o0 cat` to disable cat's line buffering, and
  the daemon's pane fan-out switched from `followFileLines` to a new
  `followFileBytes` (raw 30ms-poll byte tail).
- `projects.get` reconciles `githubRemote` against the workdir's
  origin on every call, so importing a local repo and running
  `git remote add origin …` out-of-band is detected next page load.
  Never null-clobbers a stored remote — origin can be temporarily
  renamed mid-edit.
- Picker dropdowns close on outside tap (mousedown + touchstart
  document listener while open).
- Project-detail meta row dropped its `truncate` class — `overflow:
  hidden` was clipping the absolute-positioned picker dropdowns.

## v0.3.3 — 2026-05-05

The operator-lifecycle release. Factory becomes a real long-running
service: a `factory` CLI manages a systemd user unit, daemon exposes a
structured `/health` endpoint and signals readiness via `sd_notify`,
and a channel-based upgrade flow (`stable` / `nightly` / `dev`) keeps
the live host in step with upstream. A handful of operator-immediacy
follow-ups land alongside.

### Added
- `factory` CLI binary (`@factory/cli` workspace) — `up`, `down`,
  `restart`, `status`, `logs`, `install`, `uninstall`, `channel`,
  `upgrade`, `doctor`. Installed via `bun run cli:install`.
- Systemd user unit (`Type=notify`) generated by `factory install`, with
  optional `loginctl enable-linger` so the daemon survives logout.
- Daemon `/health` endpoint returning `{status, version, uptime_ms,
  active_runs, active_sessions}`. Calls `sd_notify READY=1` after the
  listener binds.
- Upgrade channels in `~/.factory/config.yaml` (`upgrade.channel`,
  `upgrade.devBranch`, `upgrade.remote`) — `stable` (highest `v*.*.*`
  tag), `nightly` (`origin/main`), `dev` (configurable branch).
- `factory upgrade`: fetch → resolve → checkout → conditional `bun
  install` → migrate → restart → `/health` probe (15s, version match).
  Records `last-good.sha` + `upgrade-log.jsonl` under
  `$FACTORY_HOME/state/`.
- `factory doctor` preflight checklist: bun, git, unit file, unit
  active, `/health`, config, remote, linger, db.
- `skills/release/SKILL.md` — operator-invoked release ritual (changelog
  + version bump + annotated tag + push instructions). CLAUDE.md gains
  a "When to suggest a release" section.
- Two-ref diff viewer in the repo browser (`/projects/:id/code` →
  `diff` tab); unified-patch lines colorized inline; caps at 500 files
  / 1 MB per file.
- Image and SVG previews in the code viewer (`png`, `jpg`, `gif`,
  `webp`, `bmp`, `ico`, `avif`, `svg`); 2 MB cap.
- Markdown rendering in the code viewer with raw/rendered toggle,
  per-blob storage key.
- Per-feedback WebSocket scope (`?scope=feedback:<id>`) so feedback
  thread updates land without polling.
- Bare-shell session mode in the PWA — claude/shell chip toggle on the
  ad-hoc session start affordance.
- DB-backed operator settings (`settings` table; `/settings` PWA route
  with override/revert chips) for git author, run concurrency,
  GitHub token, factoryProjectId, default run budget. Yaml continues
  to seed defaults; DB takes precedence afterwards.
- Pane keystroke forwarding — typing in an ad-hoc session or live run
  pane now reaches the underlying tmux via `send-keys -H`.

### Changed
- Workdir panel on the project page is now navigable: tree, commits,
  status entries, branch, and worktrees link into the code viewer.
- Feedback iteration prompt moved from a hardcoded literal in
  `apps/daemon/src/feedback/iterate.ts` to the `prompts` table
  (`feedback-iterate-v1`); falls back to embedded literal if the seed
  hasn't run.
- `recordMergeFailure` extracted into a shared helper used by both
  runs and ad-hoc sessions; merge-failure decisions now have a single
  source of truth.

### Fixed
- TierPicker dropdown z-index — selection chip stayed visible behind
  the start-run button.
- Markdown paragraph spacing — blank-line-separated paragraphs no
  longer touch (CSS specificity bug; doubled-class selector).
- CLI `health-probe` default port — now reads from
  `$FACTORY_HOME/config.yaml` instead of a stale hardcoded 5174.
- HTTP smoke test asserting the new `/health` shape (`{status,
  version}` instead of legacy `{ok, ts}`).

## v0.3.1 — 2026-05-04

Six side-cuts from `docs/side-cuts.md` plus a few authoring affordances.

### Added
- Operator-facing worktree cleanup.
- Scoped `/ws/events` channels for per-entity reactivity.
- Structured run log + raw toggle in the PWA.
- Markdown rendering across surfaces (plans, decisions, audits).
- Unified feedback comments thread (replaces inline Discussion).
- Import existing repos — clone-from-URL or adopt-local-path.
- Prompt editing in the PWA — Monaco editor + version history;
  `upsertVersion` and `activateVersion` mutations.

## v0.3.0 — 2026-04 (approx)

Audit primitive + Path-B unlock + tier-aware onboarding.

### Added
- Audit primitive (`audits` table, runtime, prompts, promote flow).
- Audit UI + TierPicker + deepening route.
- Plan supersession; `feature_plan` and `project_vision` plan kinds;
  vision filter as freeze precondition for `feature_plan` on tier ≥
  personal.
- One-click audit template installation (`docs/audit-skill-templates/`).
- Claude metrics — `claude_metrics` table populated per `--print`
  invocation; `/metrics` PWA route with per-entity cost/token chips.

## v0.2.0 — 2026-03 (approx)

Plan primitive + quality signal.

### Added
- Plan primitive (`plans`, `plan_comments` tables) — typed payloads
  with comment threads and a freeze mechanic.
- Triage approve creates a drafting `project_spec` plan instead of
  bootstrapping directly; project materializes on plan freeze.
- Quality signal subsystem (informational, not gating) — runs invoke
  `runQualityChecks` after auto-commit; report lands in
  `runs.quality_report`.
- Plan-aware run prompt; per-project Claude model; task detail +
  spec edit; daemon-restart resilience for in-flight runs;
  state-coherent project detail page.
- Plan resume across operator comments.

## v0.1.0 — 2026-02 (approx)

Initial spine release.

### Added
- Idea → triage → decision → bootstrap → run → tag flow.
- Daemon (Bun + tRPC + WebSocket + worker pool); SQLite at
  `~/.factory/data.db`; project workdirs at
  `~/.factory/projects/<slug>`; per-run worktrees at
  `~/.factory/worktrees/<slug>/<runId>`.
- Decisions inbox + capture + projects list + settings (PWA shell,
  theme, auth gate).
- xterm.js live pane on the project page; optimistic tagging.
- `factory-status` footer protocol — every code-changing run declares
  `done | blocked | failed` in a fenced JSON block; null parse →
  `failed`.
- Auto-commit at run-end; per-run `factory/run-<id>` worktrees with
  `--no-ff` merge into main on success; auto-advance through ready
  tasks.
- v0.1 rubric and triage prompt seeded.
