# Changelog

All notable changes to Factory are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

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
