# Changelog

All notable changes to Factory are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

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
