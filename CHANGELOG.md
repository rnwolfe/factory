# Changelog

All notable changes to Factory are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## v0.40.1 — 2026-06-29

### Fixed
- **The per-run summary renders as Markdown** instead of raw text — it was dumping literal
  `**bold**` / `- bullets` through a pre-wrap block and never hit the renderer.

### Changed
- **Agent readouts and reports get a roomier reading treatment** — the hand-rolled Markdown
  styling was tuned dense; now larger line-height, more air between paragraphs and list items,
  brighter headings and softer body. Lifts every Markdown surface (run readouts, audit reports,
  plan drafts, comments).

## v0.40.0 — 2026-06-29

### Added
- **A visual language for autonomy — felt at a glance across every screen.** Now that Factory
  acts on its own, the surface makes three things instantly legible: **what needs you** (amber,
  now strictly rationed to at most one "this is yours" action per screen), **what the system is
  doing on its own** (a new calm **teal** — in-flight runs, the agent's tool calls, `auto · …`
  markers, The Watch, Heimdall's read), and **how far you've let it go** (a **trust ladder**:
  supervised → collaborative → autonomous, with clean-streak progress toward the next rung).
- **The inbox is now grouped by attention** — *needs you* · *in flight* (live runs, breathing,
  with progress) · *done while you were away* (what merged/ran unattended, FYI-only) · *settling*
  — with a Heimdall watch strip up top (running · queued · spend · needs-you).
- **Projects portfolio + dashboard show posture, not just activity** — a working/idle summary,
  per-project trust ladder, today's runs and merged-rate, and a new project **overview** tab
  (posture + vitals + in-flight + recently-merged). Project tabs now work on a phone.
- **An always-reachable emergency-stop kill-switch** — a pinned card on the Autonomy panel halts
  all unattended action immediately (wired to `autorun.emergencyStop`).
- **Verifier coverage reads as pips** — acceptance / quality / cross-model as filled (pass) /
  filled-red (fail) / hollow-ring (not covered, never mistaken for a pass).

### Changed
- Run/execution detail: in-flight runs read teal; a held run reads **parked** ("held for review");
  a retried run shows a teal **self-healing** card; the agent's tool calls are teal while the
  **commit** row keeps the one amber accent (the concrete artifact that's yours).
- Metrics lead with the **decisions-per-run** north-star in teal (down is good — "less you");
  operator memory stamps each fact with a teal provenance line; global settings pins a teal
  "autonomy policy · system" card at the top.
- Motion is calm and respects `prefers-reduced-motion` (live dots pulse, active runs breathe).

## v0.39.0 — 2026-06-29

### Added
- **Phase C — the first human-out-of-the-loop action (ADR-017).** An eligible `groom-backlog`
  Watch proposal now auto-executes — closing a stale task — instead of surfacing for approval,
  recording an `auto_ran` event (push + `/ops` history). Intentionally the smallest, safest
  class: a reversible status flip that can't break a build, behind the full eligibility gate
  (kill-switch · enabled · top-rung · class allow-list · per-tick budget). **Ships dark** — opt
  in per-project from the Autonomy tab (`autorun.enabled` + add `groom-backlog` to `classes`).
- **Full autorun/retry controls in the Autonomy panel** — `max per tick`, `require quality gate`,
  the **emergency-stop kill-switch**, and the L3 `verifier budget`, all inheritance-aware.

### Fixed
- **The run-complete notification now fires when the work is actually done.** It keyed on the
  agent's process exit — before the summary, task status, verifier gate, and merge settled — so
  you could be pinged "complete" while the task still read "yet-to-be-run" (a gate-held run skips
  the merge). It now fires at the end of finalize, only for a genuinely completed run.
- **The model's final readout renders GFM tables and task-list checkboxes** (`- [ ]` / `- [x]`)
  instead of raw text; tables scroll horizontally on phone.
- Markdown also renders on the "view all releases" page (parity with the what's-new sheet).

## v0.38.3 — 2026-06-29

### Fixed
- **Acceptance criteria are now actually verified — on every task, in every repo.** The
  structured `acceptance` array the verifier scores was only ever requested for runs from a
  frozen task plan; plain task files (milestone/feature-plan tasks, ad-hoc tasks) were never
  asked to report it, so their acceptance signal was *always* absent and autonomous runs were
  perpetually held. The base completion footer now requests acceptance against the task's own
  `## Acceptance` section. (Confirmed in prod: only 5 of 203 runs had ever reported acceptance.)
- The "what's new" brief renders **nested bullet lists** correctly instead of flowing
  sub-bullets inline as literal `- ` text.

### Changed
- **Milestone planning enforces acceptance criteria.** Freezing a feature plan on an autonomous
  project now requires every emitted task to carry at least one acceptance criterion (matching
  the task-plan gate), and the planner prompt mandates verifiable criteria per task — resolving
  the old "leave acceptance short" guidance that produced unverifiable `(TBD)` tasks.

## v0.38.2 — 2026-06-29

### Fixed
- **No-op completions skip quality checks too.** A 0-commit run's worktree is reclaimed before
  the quality checks run, so they spawned in a missing directory and logged a spurious `config`
  check failure (`ENOENT posix_spawn 'sh'`). The no-op guard now covers the quality block as
  well as the verifier gate — a no-op completion runs neither.

## v0.38.1 — 2026-06-29

### Fixed
- **Auto-retry now reuses the held run's worktree + session** for a pointed correction
  (continuity — the agent fixes the specific defect in place rather than re-approaching),
  falling back to branching from the branch tip only when the worktree was reclaimed or the
  agent can't resume (codex). v0.38.0 always reused the worktree id and died with "existing
  worktree missing from disk" when it had been cleaned up.
- **No-op completions no longer get held or auto-retried.** A run that made zero commits
  ("already done, no changes needed") has nothing to merge or verify — it now bypasses the
  verifier gate and completes, instead of being held as `needs_review` and churning through
  the auto-retry budget on already-finished work.

## v0.38.0 — 2026-06-28

### Added
- **Self-healing runs — autonomous projects auto-retry clear defects (ADR-016 slice 4).** When
  the verifier gate holds an autonomous run for an *actionable* defect (a real cross-model /
  acceptance / quality **fail**, not an absent-coverage gap), the run now **retries itself with
  the findings fed back to the agent**, up to `retry.verifierBudget` (default 2), and surfaces
  to you only if it still can't fix it. Safe by construction: the retry re-runs the gate, so
  unverified work still can't merge — a non-converging loop is bounded wasted compute, never a
  bad merge. The operator stops driving the obvious retries.
- **Auto-retry loop-health metrics.** `auto_retries`, `auto_retry_resolved` (self-healed), and
  `auto_retry_exhausted` (gave up) chart over time — a high resolved:exhausted ratio means the
  gate is catching *fixable* defects; a rising exhausted rate flags hard problems or an
  over-zealous cross-model gate to recalibrate.
- **Autonomy-event rate metrics** (contractions, promotions, gate-holds, auto-merges, auto-runs)
  in the catalog — the unattended-action rates, chartable on `/ops` + `/metrics`.
- **Phase C auto-run — eligibility gate (ADR-017, ships dark).** The pure safety core for
  self-generated work auto-running, behind seven conjunctive gates; default off everywhere.

### Changed
- **Verifier-gate holds surface clearly.** A gate-held run now reads as **"held for review"**
  (not a bare "blocked"), shows the failing signals inline (the cross-model finding, absent
  acceptance), and explains how to resolve. Approving the retry **auto-feeds the findings** to
  the agent — no more re-running blind.

## v0.37.0 — 2026-06-28

### Added
- **Autonomy is now configurable, observable, and alertable (ADR-016).** Three things:
  - **Configurable, system + per-project.** A unified autonomy policy (trust ladder,
    verifier gate, the Watch, auto-run, retry, alerts) resolved *built-in ⊕ system ⊕
    project*. A new **`/settings/autonomy`** panel and a per-project **Autonomy tab** —
    **preset-first** (Conservative / Balanced / Hands-off) with an Advanced disclosure, and
    **inheritance-aware** (each knob shows inherited-vs-overridden with one-click revert), so
    the settings/project pages aren't knob-overloaded.
  - **Observable.** An autonomy event log records every unattended action (trust moves, gate
    holds, …), surfaced as a timeline on **`/ops`**.
  - **Alertable — even when autonomous.** Out-of-the-loop work pushes "here's what I did,"
    routed per-event (loud on risk: contraction / auto-merge / auto-run push; promotions /
    gate-holds digest) and overridable per project. A Trust-Ladder contraction now pings you.

### Fixed
- The "what's new" brief renders markdown (bold lead-ins, `code`, links) instead of raw markup.

## v0.36.0 — 2026-06-28

### Added
- **The Trust Ladder moves itself (ADR-012 Slice 2).** A project's autonomy level is no
  longer a manual switch — it's driven by track record. It **contracts**
  autonomous → collaborative the moment a run fails, hits a merge conflict, or you
  **override an auto-ratified decision** (the precise "trust was misplaced" signal), and
  **ratchets up** collaborative → autonomous after 5 consecutive clean runs (completed +
  verifier-`high`). Contraction is automatic (safety wins); promotion is earned. A
  gate-held `needs_review` run is neutral. (Move surfacing — push + a header chip — is a
  fast-follow; for now it's logged + reflected in the project's mode.)
- **Verifier-gate freeze precondition (ADR-014 slice 3 — WS C complete).** Freezing a task
  plan on an autonomous-mode project now requires at least one testable acceptance
  criterion, so autonomy-eligible work always has something for the verifier to check.

### Fixed
- **GitHub reply agent:** investigates the codebase before replying to issue/task comments,
  and tears down its worktree + branch robustly.

## v0.35.0 — 2026-06-28

### Added
- **The Verifier-Coverage Gate (ADR-014).** "Is this safe to land unattended?" is now a
  *measured* score, not an assumption that `completed` = verified. Each run gets a
  verifier-confidence report — three-state coverage (pass / fail / **absent**) over
  acceptance criteria + quality checks + cross-model review — surfaced on the run with a
  level chip and per-signal breakdown. A run that "completed" with nothing checking it
  scores `none`. For **autonomous-mode** projects this gates auto-merge: high coverage +
  contained diff → auto-land; otherwise the run is **held for review** instead of blindly
  merged. Collaborative mode is unchanged.
- **Cross-model adversarial validation** (ADR-014 §D): an autonomous run's diff is reviewed
  by the *other* model family (claude↔codex) one-shot; the verdict feeds the score.

### Changed
- **Extensibility-discipline pass (ADR-015), no behavior change.** The agent registry and the
  task-backend interface are now the single touch-point for adding a variant: a shared agent
  zod-enum, cross-model validator / runtime-spec / auth-guidance all on the agent descriptor,
  and the `TaskStore` interface covering every backend op behind a `registerBackend` registry.
  Adding an agent family or a task backend is one impl + one registration.

## v0.34.0 — 2026-06-28

### Added
- **Operator memory (ADR-010 §4).** A Factory-owned git repo of the operator's
  conventions/preferences — Claude-Code memory format — browsable at a new
  first-class **`/memory`** route. Approving a Watch insight's *record-as-convention*
  proposal writes a fact into it (with provenance), and a settings action **seeds it
  by synthesizing your existing Claude Code / Codex memories** (token-heavy, runs in
  the background — "synthesis, not a mirror").
- **The Watch is now a work generator (ADR-011 Phase A/B).** Beyond reflective
  insight, it proposes *typed candidate work* that promotes through Factory's
  existing primitives, operator-gated:
  - **feature → drafting plan** (`draft-feature-plan` seeds a `feature_plan` to
    iterate), alongside the existing bug → task.
  - **In-band signal sources** — The Watch now reads Factory's own state on a
    cadence, not only out-of-band harness logs: **repeated run failures** (a
    project whose last 3 runs all failed → a task to investigate) and **stale
    backlog** (a `ready` task idle >30 days → close it). It grooms, not just adds.
  - **Backlog-aware dedup** — it never proposes work a project already tracks.
  - `note-only` is now the residual, not the default.

## v0.33.0 — 2026-06-28

### Added
- **The Watch is now observable.** A "The Watch" panel on the metrics page shows
  the synthesis loop itself: the cadence, each source's scan state (available +
  last-scanned + cursor), the observation funnel (pending/surfaced/adopted/
  dismissed/superseded), and the recent observations — **including the note-only
  ones that never became inbox cards**. The loop's daily output
  (`watch_observations_created`) is also chartable over time.
- **Autonomy & ops charts on the /metrics page.** The historical charts
  (decisions-per-run, throughput, commits, LOC, auto-ratify, autonomy mix) now
  appear on the dedicated metrics page too, not just the ops page.

## v0.32.0 — 2026-06-28

### Added
- **Autonomy & ops metrics surface — historical, charted, read-only.** The ops
  page now shows first-class time-series of how Factory's autonomic functioning is
  going: **decisions-per-run** (the autonomy north-star), throughput
  (runs/completed per day), **commits** and **LOC shipped**, the **auto-ratify
  rate**, and the **autonomy-level mix** — portfolio-wide or per-project, with a
  scope toggle and a 7/30/90-day range. Powered by a daily metric rollup
  (`metrics_daily`) over a pluggable metric catalog (a new metric is one catalog
  entry, never a migration) and rendered with real charts (Recharts). Read-only —
  awareness, not a second inbox. (ADR-013)

## v0.31.0 — 2026-06-28

### Added
- **The Watch — Factory now observes your out-of-band work.** A pluggable,
  read-only watcher reads your Claude Code (`~/.claude`) and Codex (`~/.codex`)
  sessions, synthesizes high-signal cross-session observations (recurring
  rituals, conventions, candidate tasks), and surfaces them in the inbox as
  `watch_insight` cards you can **adopt as a task**, acknowledge, or dismiss. Runs
  on an operator-tunable cadence (`watch-synthesis-cadence`: `off|hourly|daily|weekly`,
  default daily) so you control the token spend. (ADR-010)
- **Trust Ladder L2 — autonomous projects stop demanding ratification.** On an
  autonomous-tier project the agent's mid-run architectural forks are
  **auto-ratified** — recorded out of the pending inbox, kept in history, and the
  run never pauses — while the **override stays available** post-hoc (redirect any
  auto-decided fork → it resurfaces the work). A strict upgrade over the old
  autonomous mode, which discarded the fork record entirely. (ADR-012)

### Fixed
- **The daemon restarts itself after a clean termination** instead of staying
  down, and code-changing runs are warned against broad `pkill`/`killall` cleanup
  that could take down the daemon running them.

## v0.30.1 — 2026-06-27

### Fixed
- **Wide `bun test` no longer kills the parent run.** Factory now isolates its
  tmux onto a private socket (`-L`, via `FACTORY_TMUX_SOCKET`), so the daemon's
  tmux integration tests can no longer destabilize the shared tmux server that a
  self-hosting run's `claude --print` pane lives on. This was the dominant cause
  of spurious run failures — a run would commit its work but be marked `failed`
  with no factory-status footer, and it severed roughly half of all autonomous
  run chains. Production tmux behavior is unchanged (the socket flag only appears
  when the test-only env var is set).

## v0.30.0 — 2026-06-27

### Added
- **The GitHub App now reacts 👀 to a comment the moment it picks it up.** When an
  allowlisted comment passes the trust gate, Factory adds an `eyes` reaction to
  it before composing the reply — a "seen, thinking" indicator while the agent
  works. Best-effort, so it never holds up the reply.

## v0.29.0 — 2026-06-27

### Added
- **The Factory GitHub App now answers issue comments from trusted accounts.**
  When an allowlisted person comments on a tracked issue, the bot replies on the
  thread as `factory[bot]`, grounded in the project, the issue, and the
  conversation so far. Comments with no open inbox card get a free-form
  conversational reply; comments on intake/blocked-run/agent-decision cards reply
  through their existing thread.
- **Issue reply allowlist** (Settings → operator settings). A GitHub-login
  allowlist that gates who the App will answer; repo collaborators
  (owner/member/collaborator) are always answered. Empty list + no write-access =
  the bot stays silent (deny-by-default — replies are public posts).
- **Deep links back into Factory** on every bot reply — the task/project for a
  conversational reply, the inbox decision/project for intake and
  blocked-run/agent-decision replies. Built from the new **public base URL**
  setting (Settings → operator settings); omitted when it isn't set.

## v0.28.2 — 2026-06-26

### Fixed
- **Blocked-run (and other) decision cards no longer show a huge empty gap on
  iPhone.** The real cause was a WebKit/iOS-Safari `-webkit-line-clamp` bug: a
  clamped headline clips to two lines visually but leaks its full un-clamped
  height into the card's layout, pushing the question ~340px down. (Chrome was
  unaffected, so it only showed on iOS.) Line-clamped text now uses layout
  containment. Supersedes the v0.28.1 attempt, which didn't address this.

## v0.28.1 — 2026-06-26

### Fixed
- **Blocked-run inbox cards no longer show a large empty gap.** The card
  headline paired `-webkit-line-clamp` with `overflow-wrap: anywhere`, which
  makes WebKit/Blink reserve the full unclamped text height while painting only
  two lines — leaving a tall dead space above the question on long run
  summaries. The headline now clamps cleanly like the rest of the card.
- **GitHub-closed issues reconcile into the Factory task list.** Issues closed
  on GitHub are reflected back into the task list instead of lingering as open
  work.

## v0.28.0 — 2026-06-21

### Added
- **Plan the next milestone from your spec.** A project imported from a robust,
  milestone-structured spec now gets a "plan milestone" action that
  re-decomposes the next milestone straight from the committed `SPEC.md` — with
  the same rigor and editable review as the first milestone — instead of the
  thinner ad-hoc feature flow. The spec's milestone roadmap is captured into
  `AGENTS.md` at import, each task is tagged with its milestone, and progress
  (done / active / next) follows from the task list. Works on existing
  spec-imported projects too.

## v0.27.0 — 2026-06-21

### Added
- **Drop a task from any backend.** A new Drop action on the task page retires a
  task in the backend-appropriate way — a local task is marked `dropped` and
  folds into the done/dropped archive; a GitHub-Issues-backed task closes its
  issue as *not planned*. Confirm-guarded, and hidden once a task is done,
  already dropped, or has an active run.
- **Two-way operator ↔ Factory dialog on blocked runs and agent decisions.**
  Commenting on a blocked / needs-review run or an agent decision now gets a
  live agent reply instead of being stored silently — and your answers still
  ride forward into the retry. For GitHub-Issues projects the whole exchange
  mirrors to the issue thread (your comment and the agent's reply both posted
  there), and replying on the GitHub issue itself drives the agent too, so the
  conversation works from the inbox or from GitHub.

## v0.26.0 — 2026-06-21

### Added
- **Skills are first-class and harness-agnostic.** A new skills router lists and
  submits skills, a project-skills loader scans `.claude/skills/*/SKILL.md`, and
  the resolved SKILL.md body is injected into runs regardless of harness. Each
  project page now surfaces a panel of its available skills.
- **Cross-project open tasks.** A new daemon query rolls up incomplete and stalled
  tasks across every project, surfaced in the PWA as a single cross-project
  open-tasks view — so work that's still open elsewhere doesn't fall off the radar.
- **Overridden decisions resurface as open work.** Non-ratified agent decisions now
  emit a resurfacing signal through a backend-agnostic seam; for GitHub-issue
  projects the resurfaced follow-up carries a GitHub-native back-link. Resurfaced
  overrides appear in the inbox and on the board as still-open work.

### Changed
- **`/metrics` is now token-centric, not cost-centric.** The metrics page reports
  on token usage rather than dollar cost, and is promoted into the primary
  navigation.

### Fixed
- **Plan-detail freeze button no longer floats.** Un-floated so it sits inline with
  the rest of the plan-detail controls.

## v0.25.0 — 2026-06-20

### Added
- **Auto-triage parity for GitHub-issue projects.** An external issue now lands
  in the inbox with an agent triage suggestion (plan/task + reasoning), and
  operator replies — from the PWA or from the GitHub issue itself — get an agent
  response echoed back to the issue thread as the bot. Previously github-issues
  projects got a bare intake card with no analysis and no comment loop.
- **Runs that commit work but skip the status footer are preserved, not
  discarded.** A run that exits cleanly with commits but no `factory-status`
  footer (notably some codex runs) now resolves to a new `needs_review` state —
  surfaced in the inbox with its branch intact — instead of being marked
  `failed` and thrown away.
- **First-class intervention history.** The blocker → operator-reply → re-run
  loop is now recorded as a queryable intervention and shown on the blocked-run
  decision (blocker → reply → retry → outcome), instead of being scattered
  across run and comment records.
- **Queue-empty nudge (opt-in).** With the new "notify on empty queue" setting
  enabled, a project whose ready queue drains surfaces a single inbox nudge to
  re-fill or archive, so projects don't stall silently. Off by default.
- **Real favicon + PWA icons** from the Heimdall mark.

### Fixed
- **Quality checks no longer false-fail on missing types.** Fresh run worktrees
  install dependencies before quality checks, fixing spurious `bun-types`/`bun`
  typecheck errors on otherwise-clean runs.
- **Refinements re-open completed tasks.** A refinement that revises a done
  task's acceptance re-opens it so the corrected plan actually runs.
- **`factory upgrade` records state under the daemon's home.** Upgrade
  bookkeeping (`last-good.sha`, upgrade log) lands in the daemon's
  `FACTORY_HOME` instead of the default `~/.factory`, so `factory channel` and
  `factory status` report the truth on hosts with more than one home.
- **Repaired the Drizzle migration snapshot chain** — a missing `0031` snapshot
  made `db:generate` emit broken migrations.

## v0.24.0 — 2026-06-15

### Added
- **Releases cut from the inbox now push automatically.** Confirming a release
  proposal runs the gated bump/changelog/tag on the run's branch, and Factory
  pushes `main` + the tag to origin from the project checkout after the run
  merges (the run can't push correctly from its worktree, where `main` is
  stale). Push failures are reported in the run summary for a manual push; the
  local release stays intact.
- **Source/provenance links across the inbox** — decision cards and detail
  views link back to where an item came from (captured feedback, an intake'd
  GitHub issue, and so on).

### Fixed
- **The release template runs the project's gates** (typecheck + lint + tests)
  and prefers the project's own release tooling — no more `--skip-checks`, no
  more silently not pushing.
- **Feedback triage context is preserved on promotion**, and agent draft
  suggestions render in the feedback view.
- **Inbox snoozes resurface when they expire.**

## v0.23.0 — 2026-06-14

### Added
- **Release as a confirm-in-inbox templated function.** Cutting a release no
  longer asks for a version number: the `release-project` template resolves the
  version from the change set (semver-from-conventional-commits) and drafts the
  "what's new" prose, then lands a release proposal in the decisions inbox.
  Confirming it cuts the release (bump + changelog + tag); dismiss discards. Two
  reusable template capabilities underpin it — model-resolved variables
  (`resolver: { kind: "agent" }`) and `confirmInInbox` templates. See ADR-008.
- **Snoozed-items filter view in the inbox** — review what you've snoozed.

### Fixed
- **Newly created plans auto-draft.** Plans created via triage-approve (and
  startRefinement) now kick off their first iteration immediately instead of
  sitting idle in `drafting`.

## v0.22.0 — 2026-06-14

### Added
- **Pull-to-refresh on the app shell.** Touch and scroll-at-top invalidates the
  active queries, so a pull at the top of any screen refreshes its data.
- **Snooze storage for inbox items.** Database layer backing inbox-item snooze.
- **Per-task agent + model picker.** The task page exposes a fused
  AgentModelPicker, so the model options shown switch to match the selected
  agent (codex and claude have disjoint model ids).

### Fixed
- **Codex runs no longer die when handed a Claude model.** Agent and model
  resolve on independent ladders at run submit, so a model pinned for one agent
  (e.g. a `claude-*` id in a task's frontmatter) could land on a run that
  resolved to a different agent (codex, from the project default). Codex got a
  model it can't run, exited within seconds without a factory-status footer, and
  surfaced as a "blocked run" with no actionable reason. Submit now clamps a
  cross-agent model id to the resolved agent's default (unknown/experimental ids
  pass through untouched).
- **Push notifications carry run context.** The notification body now includes
  the project and task for a run, not just a bare status.
- **Decision inbox items show their project.** Inbox decision cards and the
  detail view surface the originating project.
- **Feedback vote buttons color on selection** (green for up, red for down).

## v0.21.9 — 2026-06-14

### Fixed
- **GitHub `issue_intake` decisions render correctly and notify.** Externally
  filed issues land in the inbox as `issue_intake` decisions, but the kind was
  only half-wired into the UI: the full decision view showed a "tag change" chip
  and a bare "intake" headline, the desktop split-pane showed an empty body, and
  the push notification used the generic "decision needs review" copy. The
  decision route and split-pane now show "issue · intake", a "#<n> <title>"
  headline, who filed it, and a promote-to-task action; the push notification
  reads "new GitHub issue · #<n> <title> · @<author>".

## v0.21.8 — 2026-06-13

### Fixed
- **Mobile bottom-nav bottom gap (root cause).** The responsive shell used
  `h-[100dvh]`, but in the installed iOS PWA `dvh`/`svh`/`vh` all resolve to the
  status-bar-excluded height (on-device: 873 on a 932px screen), and — the shell
  being top-anchored — the ~59px shortfall surfaced as a strip of page
  background below the nav. Switched the root to `h-[100lvh]` (the only unit
  equal to the full physical screen here), so the nav reaches the true bottom
  edge. Removed the temporary on-screen diagnostics added in v0.21.3–v0.21.7.

## v0.21.5 — 2026-06-13

### Fixed
- **Removed the temporary nav diagnostic overlay** (added v0.21.3–v0.21.4).
  On-device measurement confirmed the mobile bottom nav is compact (~57px, flush
  at the viewport bottom, `padding-bottom` capped at `0.5rem`); the earlier
  oversized appearance was the uncapped `env(safe-area-inset-bottom)` band still
  being served from the service-worker cache.

## v0.21.3 — 2026-06-13

### Changed
- **Temporary on-screen nav diagnostic.** A debug overlay printing viewport /
  safe-area / nav measurements, to pin down the mobile bottom-nav gap on-device.
  Reverted in the next release.

## v0.21.2 — 2026-06-13

### Fixed
- **Mobile bottom-nav dead space.** Capped the home-indicator clearance
  (`env(safe-area-inset-bottom)`) at `0.5rem` — the full inset was reserving a
  large empty band below the icons, so the bar read oversized. Icons unchanged.

## v0.21.1 — 2026-06-13

### Fixed
- **Mobile bottom-nav height.** Trimmed the nav content row from `h-14` to
  `h-12` (≈ the iOS-standard tab-bar height) so it matches the header and no
  longer reads chunky above the home-indicator safe-area band.

## v0.21.0 — 2026-06-13

GitHub integration beyond repo publish: Issues become a per-project canonical
task backend, with a first-class `factory[bot]` identity for machine actions,
the issue comment thread as first-class run context, and inbound sync via the
App webhook. Opt-in per project — `file`-backed (incl. `tinker`/local) projects
are unchanged. See [`docs/adr/007-github-issue-backend.md`](./docs/adr/007-github-issue-backend.md)
and [`docs/spec-github-issues.md`](./docs/spec-github-issues.md).

### Added
- **Factory GitHub App identity (`factory[bot]`).** On App-installed repos, run
  commits + pushes attribute to the bot (via the App's noreply email +
  installation-token auth) instead of a dangling string author — consistent
  identity across commits and issues/comments. Configured via `auth.githubApp`
  / the `github-app-*` settings; `factory doctor` reports it.
- **GitHub Issues as a canonical task backend (per-project opt-in).** A project
  can flip to `task_backend = github-issues`: existing tasks backfill into
  issues (status round-tripped via `status:*` labels + a hidden `factory:task`
  frontmatter block; old ids preserved as `legacy_id`), local `.factory/work`
  files are archived, and from then on the issue *is* the task.
- **Issue thread as first-class run context.** For github-backed tasks the issue
  comment thread is folded into the run prompt (delimited, marked untrusted,
  all authors), and each run writes its outcome back to the thread as the bot
  (completion summary + merged sha + quality, blocked-run questions).
- **External-issue intake.** An issue filed outside Factory on an integrated
  repo surfaces as an `issue_intake` inbox decision; approve adopts it as a
  task, dismiss leaves it untracked — external input never silently runs.
- **App webhook** (`POST /webhooks/github`, HMAC-verified) for live inbound
  sync. The app-level hook receives events for every installed repo, so each
  delivery is gated to a github-issues-backed project and unmatched repos are a
  fast no-op.
- **PWA:** a task-page issue thread + reply (authored as the operator via their
  PAT), the `issue_intake` decision card (promote/dismiss), and a per-project
  "use github issues" opt-in button. Both mobile and desktop layouts.

### Changed
- **Task IO is now a pluggable `TaskStore` seam** behind `apps/daemon/src/projects/tasks.ts`
  (`file` + `github-issues` providers); every task-creation/update flow routes
  through `taskStoreFor(project)` unchanged. Migration `0029` adds
  `projects.task_backend` + `projects.github_installation_id`.

## v0.20.2 — 2026-06-11

### Fixed
- **Mobile bottom nav anchors to the screen bottom again.** The nav (and
  feedback FAB) relied on viewport `position: fixed` under an iOS body-scroll
  model and drifted up into mid-content. Reworked the app shell into a
  `100dvh` flex column with the content area as the sole scroller and the
  nav as a flex child, so it can no longer leave the bottom — immune to the
  iOS fixed-positioning quirks the prior two tweaks chased.

## v0.20.1 — 2026-06-11

### Added
- **Auto-triage feedback on inbox arrival.** Feedback items are triaged
  automatically the moment they land in the inbox, instead of waiting for
  an explicit triage step.

### Fixed
- **New-task modal no longer steals focus on re-render.** The title input
  focuses once on mount rather than on every render, so it stops yanking
  focus mid-interaction.
- **iOS PWA bottom-nav gap on scroll bounce.** The bottom navigation no
  longer opens a gap when the page rubber-bands during scroll.
- **Run event log shows project-relative paths.** Tool event paths are
  relativized against the worktree root, stripping the worktree prefix.

## v0.20.0 — 2026-06-10

### Added
- **Opus 4.8 model.** `claude-opus-4-8` ("opus 4.8", most capable) joins
  the claude-code model lineup, available to every project. `opus 4.7`
  stays selectable, relabeled "prior flagship".
- **Fable 5 behind a feature flag.** `claude-fable-5` ("fable 5") appears
  in the claude-code model picker only when the new `experimental-fable-5`
  user setting is on (off by default). The model is appended by
  `agents.list` at request time rather than baked into the registry, so
  opted-out operators never see it; a settings toggle flips it and
  refreshes the picker immediately. Run submission treats model ids as
  opaque, so a selected Fable 5 run still dispatches if the flag is later
  toggled off.

### Fixed
- **`settings.get` now returns `ops.defaultAgent`.** The settings UI
  already read it; the router never sent it, so the default-agent picker
  read `undefined` until changed.

## v0.19.0 — 2026-05-26

### Added
- **`release` button on the project header.** Cuts a release of the
  current project via a seeded `release-project` task template — opens
  the variable form directly (version + optional notes; no picker step).
  The template's agent-rendered Recipe section defers to the project's
  `skills/release/SKILL.md` if present, falling back to a generic
  semver-bump + changelog + annotated tag flow otherwise. Implementation
  is a thin specialization on v0.17.0's task templates; no new primitive,
  no `releases` table.
- **Seeded task templates infrastructure.** New `SEEDED_TEMPLATES` array
  in `packages/db/src/seed.ts` upserts on every daemon start. Operator
  edits to a seeded template (name/description change) are preserved on
  subsequent seeds; body-only refreshes re-seed.
- **`preselectSlug` on `InstantiateTemplateModal`.** Lets any caller
  (release button today; deploy / hotfix / etc. tomorrow) open the modal
  pre-pointed at a specific template, skipping the picker. Same
  underlying flow.
- **Project workdir passed as `cwd`** to the model invocation for agent-
  rendered template sections, so the agent can Read project files like
  `skills/release/SKILL.md` at render time without an upstream prompt
  injection.

## v0.18.0 — 2026-05-26

### Added
- **Task templates in the Ctrl+K command palette.** New "Task templates"
  nav entry jumps to the library; each individual template shows up as
  its own palette item with the description as the hint and navigates
  straight into its editor route. Library is queried lazily on palette
  open. Search the palette by template name or description.

## v0.17.0 — 2026-05-26

Cross-project task templates. Author a reusable blueprint once (release-
notes flow, expose+systemd deploy, operator-CLI scaffolding); instantiate
into any project with one click. Agent-rendered sections read the target
project's AGENTS.md + recent commits and tailor the task body to its stack.

### Added
- **`task_template` plan kind.** Authoring goes through the same
  iterate-with-agent / freeze flow as project_vision and feature_plan.
  Templates are Factory-canonical (cross-project, alongside rubrics and
  prompts) — explicit exception to the "per-project artifacts are
  repo-canonical" doctrine, since templates by definition aren't
  per-project. Migration 0028 adds the `task_templates` table.
- **"from template" picker** on the project header. Two-step modal:
  pick a template from the library, fill the variable form, optionally
  toggle "tailor agent sections to this project," instantiate →
  navigates straight into the new task page. Variables surface as
  inputs with descriptions and defaults; agent sections invoke the
  model once each with the target's context.
- **Settings → library → task templates.** List view + form editor for
  direct authoring/refinement. Parallel surface to plan-iterate, same
  underlying storage. Includes an inline "draft with agent" seed: type
  a goal, agent iterates the variable+section breakdown.
- **Static + agent-rendered sections.** Static sections do `{var}`
  substitution against operator inputs + project-derived helpers
  (`{projectName}`, `{projectSlug}`). Agent sections carry an
  instruction-to-the-renderer body; instantiate-time invocation reads
  the target's AGENTS.md, README, and recent commits and returns
  per-project tailored markdown. Recorded under
  `ownerKind=plan_iteration` so the cost surfaces in the metrics view.
- **`taskTemplates.{list,bySlug,update,archive,unarchive,instantiate}`
  tRPC routes.** `plans.startTaskTemplate` for the plan-iterate flow.

## v0.16.0 — 2026-05-26

The "open in agent session" affordance on recovery-prompt blocks. Stuck
runs now have a one-click path from decision card to interactive agent
attached at the run's worktree, with the recovery prompt pre-typed.

### Added
- **`sessions.start` attaches to existing run worktrees.** New optional
  `fromRunId` field reuses the run's branch + worktree via the runtime's
  `attachExistingWorktree` helper instead of forking a fresh
  `factory/adhoc-*` tree off main. The operator lands directly in the
  half-done work where the run left off.
- **`sessions.start` injects an initial prompt.** New optional
  `initialPrompt` field auto-types into the agent ~1.5s after boot via
  `tmux send-keys` (no trailing Enter — operator reviews and submits).
  Best-effort; failure logs but doesn't fail session-start, so copy-
  paste remains a fallback.
- **'open in claude/codex session' button** on the recovery-prompt block.
  Picks the original run's agent (so a codex-produced failure opens a
  codex session, claude → claude), starts a session attached to the
  run's worktree, navigates the operator straight into the session pane
  with the recovery prompt pre-typed. The previous copy-button stays as
  the always-works fallback.

## v0.15.0 — 2026-05-26

Scenario-specific operator-intervention prompts on every decision card
that needs human help. No more digging up worktree paths and branch
names to drive a recovery — the prompt is pre-filled with everything an
interactive agent needs.

### Added
- **Recovery-prompt block on blocked-run + merge-failure decisions.** Six
  scenarios covered, classified daemon-side from the decision payload:
  `blocked_run_failed` (factory-status-null), `blocked_run_questions`,
  `blocked_run_usage_capped`, `merge_failure_dirty`,
  `merge_failure_conflict` (file paths extracted from the merge message),
  and `merge_failure_other`. Each carries worktree path, branch, base
  ref, summary, and (where relevant) the agent's questions or the
  conflicted files, plus the task body so the recovering agent has the
  acceptance criteria.
- **`recoveryPrompts.forDecision` tRPC route.** Returns `null` for
  decision kinds that don't need a prompt (`tag_change`, `triage`,
  `agent_decision`) so the PWA component renders gracefully — every
  consumer treats the response as opaque.
- **Copy button + scenario label** on the prompt block. Falls back to
  range-selection when `navigator.clipboard` isn't available (http
  origins, private browsing).

### Follow-up
- "Open in agent session" affordance is deferred — it needs
  session-attach-to-existing-worktree wiring (today's `sessions.start`
  creates a fresh worktree off main). Copy-paste is the v1 path.

## v0.14.0 — 2026-05-26

Per-harness metrics + the operator-facing 'X hours of agent work'
headline. Codex usage was already captured; now it's a first-class
axis you can drill down on.

### Added
- **`metrics.runtime` tRPC query** + a top-of-page headline on `/metrics`:
  agent work (wall-clock from `runs.ended_at − runs.started_at` summed
  over completed runs), API time (`SUM(claude_metrics.duration_ms)`), and
  runs completed. Per-project and per-agent breakdowns ride in the same
  response.
- **By-agent breakdown section** on the metrics page — wall-clock hours +
  run count per harness, sorted desc.
- **`daily.groupBy='agent'` and `'agent+model'`.** Per-harness time-series
  is a direct column read; the composite key (`<agent>||<model>`) keeps
  per-model series scoped under their parent harness so codex's
  `gpt-5.4` doesn't get lumped with claude's `claude-sonnet-4-6` when
  the operator wants to see both legends.

### Changed
- **`claude_metrics.agent` column** + index `(agent, created_at)` for the
  per-harness query path. Migration 0027 backfills existing rows from
  the model prefix (claude-* / opus-* / sonnet-* / haiku-* → claude-code;
  gpt-* / codex-* → codex). Table name stays `claude_metrics` (historical);
  every consumer-facing identifier on the TS side goes agent-neutral.
- **`recordAgentMetrics`** replaces `recordClaudeMetrics` (legacy alias
  preserved). Every caller — runner, triage, plan iteration, audit
  iterate/exec/promote/comments, feedback iterate, spec-import — now
  passes the agent id it already had in scope, so per-harness slicing is
  a column read, not model-prefix inference.

### Known follow-up
- Parallel sub-agent (Task tool) per-token attribution isn't recoverable
  from the parent's stream — Claude Code surfaces sub-agent calls as
  opaque `tool_use → tool_result` pairs. Wall-clock for sub-agent gaps
  can be derived from log timestamps when needed; per-model attribution
  needs harness-side instrumentation.

## v0.13.0 — 2026-05-26

One AgentDescriptor registry collapses every "which harness?" call site
into a single drop-in spec. Codex becomes a session mode along the way.

### Added
- **Codex as an ad-hoc session mode.** The session picker on the project
  page now offers `claude`, `codex`, and `shell` — codex sessions launch
  an interactive codex pane in the worktree. The previous "claude or
  shell only" surface was the smoking gun motivating the registry
  consolidation.
- **`agents.list` tRPC route.** Serves the registry's serializable view
  (id, label, hint, models, supports) so the PWA picker, retry-agent
  chips, and any future agent UI all read from a single source of truth.

### Changed
- **AgentDescriptor registry** at `apps/daemon/src/agents/registry.ts`
  is now the single source of truth for every agent Factory dispatches
  to. Each descriptor carries id, label, hint, model list, support flags
  (`resume`, `interactiveSession`), the runtime spec, an optional auth
  probe, and the interactive launch command. Adding a new harness is one
  registry-entry edit; every consumer (run submission auth probe, parity
  guards, session launch, PWA model picker, retry-agent chips) refreshes
  automatically.
- **Session modes renamed.** The canonical mode set is now
  `shell | claude-code | codex`. The legacy `claude` value is accepted at
  the API boundary for back-compat with older PWA builds; stored rows are
  migrated in place to `claude-code` (migration 0026).
- **`workers/submit.ts` auth probe is registry-driven.** The hardcoded
  `probeCodexAuth()` call is replaced by `descriptor.probeAuth?.()` so
  any future agent with auth requirements wires in by adding the probe
  to its descriptor.

### Known gap
- `apps/cli/src/commands/doctor.ts` still embeds a hardcoded codex auth
  check rather than iterating the registry — the CLI is a separate
  workspace and importing from `apps/daemon` would require lifting the
  registry into a `packages/` module. Filed as a follow-up for when a
  third harness lands.

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
