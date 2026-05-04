# Factory — post-v0.1 direction

> **Status:** living document. Started 2026-05-03 after v0.1 spine landed.
> Last revised 2026-05-04 — v0.2 shipped (Plan primitive + quality signal),
> v0.3 reframed around the audit primitive (ADR-003) and Path-B unlock.
> **Audience:** future Ryan, future Claude sessions.
>
> The spec's §13 backlog remains the authoritative seed. This doc records what
> living with each release actually taught us and re-prioritizes the next cut
> against operator-lived signal.

---

## 1. The bet, restated

The factory is a single-operator software studio: ideas in, projects out, with
agents under loose human supervision. The operator's only must-respond surface
is the decisions inbox. Everything else is read-only or one-tap.

That bet survives v0.1. The spine works: idea → triage → decision card →
approve → bootstrap → run → tag. We can iterate on it now without losing the
shape.

Living with v0.1 surfaces a duality the spec didn't name: **the factory has
two paths, not one.** *Path A — net new* is what v0.1 optimized: a fresh
idea passes through triage, becomes a project, runs tasks. *Path B —
continuous execution* is what every project becomes after bootstrap: a
long-lived codebase with a vision, conventions, and a backlog, where the
operator says "ship feature X" or "fix bug Y" and expects work that
adheres to what the project already is. v0.1 served Path A well; Path B
is currently a thin layer of "submit a run on a task." Architectural
decisions in v0.2 must keep both paths in view — getting Path B wrong is
how unattended runs drift away from the project's vision.

## 2. What v0.1 actually shipped (relative to spec)

The spec described the spine; the build added a handful of contracts the spec
didn't pre-specify. They're load-bearing — see `CLAUDE.md` for the
"don't-break-casually" list. Highlights:

- **`factory-status` footer protocol.** Every code-changing run requires the
  agent to declare `done | blocked | failed` in a fenced JSON block. Null
  parse → `failed`. This is the only thing preventing "the CLI exited 0
  therefore the work is done" lies.
- **Auto-commit at run-end.** Worktrees go through `commitAllChanges` before
  the runtime computes the commit list. Without this the agent's edits could
  ride on `factory/run-*` branches that were identical to main.
- **Per-run worktrees relocated.** Worktrees live at
  `~/.factory/worktrees/<slug>/<runId>`, not `<project>/worktrees/`. Project
  workdirs stay clean.
- **Triage comment threads.** Operators can reply to a triage decision; the
  agent re-triages with the thread context, returning a structured `reply`
  rendered alongside its updated verdict.
- **Run-time log persistence + replay.** `runs.rawLog` reads the persisted
  pane log with byte-offset paging; the live pane replays it on revisit so
  xterm doesn't go blank after navigation.
- **Auto-advance.** A successful run with `autoAdvance` on chains into the
  next ready task. Toggleable per-project. Default ON.
- **Per-project Claude model.** Opus / Sonnet / Haiku / default (CLI's pick),
  set at decision-approve time and editable from the project header. Threaded
  through to `claude --model`.
- **Triaging indicator + idea capture WS event.** The inbox now shows
  in-flight triage so a captured idea isn't invisible.
- **Project workdir snapshot.** Branch, head SHA, dirty status, commits,
  worktrees, and a top-level file tree, surfaced on the project page.
- **Task detail + spec edit.** `/projects/:id/tasks/:taskId` — view runs,
  edit task body. Frontmatter-preserving rewrite.
- **State-coherent project page.** Active runs are computed once and
  threaded through header CTA, task rows, and the runs list, so the UI
  never says "start task-002" while task-001 is running.
- **Blocked-run retry + inbox surfacing.** A blocked run inserts a
  `blocked_run` decision in the inbox carrying the agent's summary,
  questions, and source-run pointer. Approve = retry: a new run is
  submitted whose worktree is based on the source run's branch tip, so
  the auto-commit and partial work ride forward. Dismiss leaves the run
  blocked. Implemented via a `baseRef` column on `runs` and the new
  `runs.retry` mutation; `BranchStrategy.head` accepts an optional
  `baseRef`.
- **Auto-merge run branches into main on success.** Per ADR-001 every run
  commits to a per-run `factory/run-<id>` branch (concurrency isolation).
  v0.1 originally had no merge step, so the project's `main` never moved
  past bootstrap, the project root looked empty, and auto-advance couldn't
  compound — every subsequent task started from bootstrap, not from prior
  work. Fixed by `mergeIntoMain` in `packages/runtime/src/worktree.ts`:
  on `status="completed"` the runner does a `--no-ff` merge of the run
  branch into `main`, refusing if the project tree is dirty or `HEAD`
  isn't on `main`. Conflicts abort the merge so `main` stays clean; the
  failure note lands in the run summary and **auto-advance is held**
  (the next task would otherwise start from a main that doesn't include
  this run's work). Per-run branches are still preserved on disk for
  diff/audit.
- **Daemon-restart resilience for in-flight runs.** A boot-time reaper
  in `apps/daemon/src/workers/recover.ts` reconciles every run left in
  `running`/`queued` from a prior process via a three-tier salvage:
  (1) read the agent's persisted stream-json log and try to extract a
  final `factory-status` declaration — if found, the row is updated
  with the declared status (no re-spawn needed); (2) if the run row
  carries a `sessionId`, kill any leftover tmux session and re-submit
  the run with `claude --resume <sessionId>` plus a continuation prompt
  (`wrapResumePrompt`) — the agent picks up its prior conversation
  rather than starting over; (3) only if both fail, mark the row
  `aborted`. The runner's `runStatusFor` was also fixed to prefer the
  agent's own declaration over the abort flag, so a graceful
  `runs.abortAll()` during shutdown no longer discards completed work.
  Together: `bun --watch` reloads, SIGTERM, and any other interruption
  during a run are now non-destructive — work either lands cleanly or
  resumes on next boot.

The §14 open questions in spec.md are addressed in `docs/adr/001-v01-open-questions.md`.

## 3. What v0.1 use surfaced

Living with the tool produced these signals (chronological-ish, paraphrased):

- **The agent will lie about completion.** Solved by `factory-status`.
- **A run can ship "successfully" without committing anything.** Solved by
  auto-commit + diff panel. Quality signal is still thin (see §4).
- **The live pane goes blank when you leave and come back.** Solved by raw-log
  replay.
- **Tasks queue up but the operator has to kick each one off.** Solved by
  auto-advance.
- **One model isn't right for every project.** Solved by per-project model.
- **Triage often needs back-and-forth.** Solved by comment threads + agent
  re-triage.
- **Captured ideas are invisible until triaged.** Solved by `triaging` query
  + WS event.
- **Tasks need to be refined, not just executed.** *Partially solved* — task
  body is editable, but the conversational refinement loop (the `~/dev/forge`
  workflow) isn't built yet. See §4.
- **State scattered across the project page.** Solved by the coherence pass.
- **Concurrency UX implies sequential execution.** Solved at the daemon level
  (pool concurrency=4 was already real); UX was the gap.
- **Agents get blocked by sandbox/permission constraints.** *Open.* The
  factory needs a supported answer for "how do I let Claude Code write
  files in this run." See §5.

## 4. v0.2 — planning as the unlock

Living with v0.1 made one signal sharper than the rest: **unattended runs
succeed in proportion to planning depth.** Robust, debated, frozen plans
keep agents on rails. Thin one-line tasks don't. "Continue overnight"
isn't a model-quality story; it's a planning-quality story.

The spec's "spec foundry" stage (§13, originally v0.4) is the frame that
solves this — but it's bigger than just "between approve and bootstrap."
Project foundry is one of several places the factory needs structured
agent collaboration around a typed plan: task expansion, refinement, and
(later, for Path B) feature planning all share the same shape. Triage
already does this shape for ideas → decisions.

So v0.2's headline is not "task refinement" — it's a **first-class Plan
primitive** that all of these inherit from. ADR-002 sketches the
architectural commit; `docs/spec-v0.2.md` is the implementation-ready
spec. The four-item v0.2 cut, in priority order:

1. **Plan primitive.** Typed payload + comment thread + freeze mechanic.
   New `plans` and `plan_comments` tables. Drafting plans surface in the
   inbox. The substrate.
2. **Project foundry instance.** Triage approve creates a `project_spec`
   Plan instead of bootstrapping directly. Operator iterates the spec
   with the agent; bootstrap reads the frozen plan. Prevents the task
   churn caused by `spec_stub` being a single-shot guess.
3. **Task plan instance.** Optional per-task — operator triggers
   "expand" from task-detail; the agent produces decomposed steps,
   acceptance criteria, file touches, and risks. Runs read the frozen
   plan as authoritative prompt context. Optional so cheap tasks don't
   pay the planning tax.
4. **Quality signal in run summary.** Lint/typecheck/test runner the
   run executes opportunistically, surfaced in the run summary panel.
   Complements (3): a frozen plan is only as useful as feedback against
   it. A plan-aware `factory-status` extension can additionally report
   which acceptance criteria were met (see ADR-002 open question 4).

Demoted from earlier proposals:

- **Refinement** (`kind: "refinement"` Plan). Substrate exists; UI
  affordance is small. Ships in v0.2 if cheap, slips to v0.2.5 / v0.3.
- **Push notifications.** Comfort, not capacity. v0.3.
- **Marinate scheduler, worktree pruning, in-app rubric editor,
  multi-iteration `createSession`, multi-provider.** All v0.3.
- **Task status propagation refinement** (distinguishing
  `blocked_question` from `blocked_failed`). The Plan substrate makes
  this near-free in v0.3, since a blocked run with an attached
  unfrozen `refinement` plan *is* `blocked_question`.

The CLAUDE.md "don't generalize before the second instance" rule: we
have triage, project foundry, and task plan as three concrete instances,
with refinement and feature plan as fourth and fifth. The primitive is
justified, not premature. Risk mitigation: build the primitive *and*
both v0.2 instances at the same time so we know it generalizes — don't
ship a primitive without a second consumer.

Sandbox/permissions: see §5 — interim posture is
`--dangerously-skip-permissions` + worktree isolation. Real sandbox is a
v0.5+ concern unless threat model changes.

## 5. Sandbox & permissions — interim posture

A run was reported with the agent declaring itself blocked because every
`Write`/`Edit` returned a pending permission prompt with no human to approve,
and `Bash` redirections / `mkdir` / `touch` into the worktree were rejected
even though the same worktree was named as the allowed dir.

**Interim resolution:** code-changing runs are invoked with
`--dangerously-skip-permissions`. Wired in
`packages/runtime/src/agents/claude-code.ts` as part of the base argv. This
is the supported way to run non-interactively today; the factory's isolation
boundary is the per-run worktree (`~/.factory/worktrees/<slug>/<runId>` on a
disposable `factory/run-<id>` branch), not the CLI's permission gates.

Triage is unaffected — it doesn't go through `runtime.spawn`, doesn't write
files, and stays on the cautious path.

**Long-term:** the right answer is a real sandbox. Spec §13's container
provider, originally slotted v0.5+, becomes the upgrade target whenever a
run earns it (multiple operators, untrusted code execution, supply-chain
exposure). Shape of that change:

- Container provider implementing `SandboxSpec`, worktree bind-mounted, no
  host filesystem access outside it.
- Network policy per-run (default deny, allow-list for package registries
  and the agent's API).
- The `--dangerously-skip-permissions` flag goes away because the sandbox
  *is* the permission grammar.

Until then: skip-permissions + worktree isolation + `factory-status` honesty
is the floor. Don't put runs on the host filesystem outside their worktree
without a deliberate decision.

## 6. What v0.2 use surfaced (signals shaping v0.3)

v0.2 shipped the Plan primitive end-to-end + the quality signal subsystem
(ADR-002, `docs/spec-v0.2.md`). Living with it for a short time produced
these signals:

- **Plans without session resume are quota arson.** v0.2 shipped fresh
  `claude --print` per comment turn — every operator nudge replayed the
  full template + thread. Fixed in a v0.2 follow-up: plan iteration now
  threads a single claude session across comments via `--resume`,
  invalidated on prompt-version drift. Spec stays the same; runtime
  changed. **Lesson for v0.3:** any new agent-collaboration surface
  (audits, vision iteration) is session-resumable from the start.
- **"How do I update a frozen plan?" was unanswered.** v0.2 said
  freeze is the terminal state. Operators want to amend frozen plans
  when reality shifts. v0.3 introduces **plan supersession** — a new
  plan can supersede a frozen one in the same kind+target. The
  superseded plan stays as audit trail; the new one becomes
  authoritative. First instance: `project_vision` plans (the doc grows
  over time). Second instance covered by the same mechanic: any plan kind.
- **The seeded prompts were invisible.** Operator could not see what
  the agent was running until an agent turn happened. Fixed in a v0.2
  follow-up: `/settings/prompts` lists active prompts with line counts
  and content. **Lesson for v0.3:** Factory state should be inspectable,
  not magic.
- **CLAUDE.md is the agent's reading list, not a magic prepend.** Early
  sketches for v0.3 had Factory auto-prepending VISION.md to run
  prompts. Rejected — that is a class of "did I include the right
  context?" bugs waiting to happen. Instead: CLAUDE.md (always
  present) names what the agent should read, and the agent loads
  doctrine by following references. v0.3's job is to make sure
  CLAUDE.md content is good enough that following references is
  sufficient.

## 6.1 v0.3 — Living projects

Projects live longer than the burst that creates them. v0.1 + v0.2
optimized for "spawn a project from an idea." Every run after bootstrap
is implicitly Path B (continuous execution on a long-lived codebase),
and Path B is the gap v0.2 explicitly didn't fill. v0.3 closes it,
together with the verification surfaces that make Path B safe.

The theme: **projects accrue authored, versioned alignment artifacts
that audits keep honest.**

Four architectural commits in v0.3 (each warrants ADR-level care; the
audit primitive gets ADR-003 explicitly):

1. **Audit primitive.** Read-mostly agent invocations that produce
   structured *reports*, not commits. Distinct lifecycle from runs
   (running → completed → reviewed → approved | rejected). Skills
   live at `<project>/.factory/audits/<name>/SKILL.md`, version-controlled
   with the project. Reports start as Factory-internal DB rows; on
   approval, they get committed to the project repo at
   `docs/internal/audits/<date>-<slug>.md`. The repo file is canonical;
   Factory's row is a fast index. See ADR-003.
2. **Findings → action.** An audit report's findings are the new
   "decision currency." The operator selects 1..N findings; one Claude
   invocation evaluates tractable path forward and recommends either
   "create a plan" (drafts a `task_plan` or `feature_plan` from the
   findings, operator iterates as v0.2) or "create a bug" (drops a
   minimal task with title + body, labeled `bug` + `needs-refinement`,
   refined later via the existing `refinement` plan flow). The bug
   path forces a small new primitive: direct task creation outside any
   plan freeze. Useful well beyond audits.
3. **`feature_plan` (Path B unlock).** Implements the kind reserved
   in v0.2/ADR-002. Triggered from project page, from a Path-B idea
   capture (idea attached to a project), or from audit-finding
   promotion. Freeze emits tasks into the existing project — no
   bootstrap. For tier ≥ personal, the **vision filter** (identity /
   principle / phase / replacement, borrowed from forge's `/product`
   skill) is a freeze precondition.
4. **`project_vision` plan kind + tier-aware onboarding.** Authors
   `docs/internal/VISION.md`. Auto-triggered after `project_spec`
   freeze for tier ≥ personal; opt-in for tinker. `project_vision`
   plans supersede prior frozen vision plans rather than replacing
   them in place — the supersession chain is the project's
   architectural diary. Tier (`tinker | personal | share | productize`)
   graduates from a v0.1-vestigial axis to an actually-meaningful one
   gating onboarding depth.

Plus four smaller pulls that fit inside the existing envelope:

- **Plan supersession.** Generic mechanic; first instance is
  `project_vision`, immediately useful for `task_plan` / `refinement`
  too.
- **Drift detection.** Single shipped audit kind: takes a frozen
  `task_plan`, compares actual run touches against `touches`, reports
  drift.
- **Task sweep.** Default audit kind: scores tasks against a project
  quality checklist, flags `task/needs-refinement`, queues them for
  `refinement` plans.
- **Project deepening flow.** Operator-triggered on existing projects
  to add VISION + initial audit skills post-bootstrap. Analog of
  forge's `/onboard --verify` for a project that's grown past tinker.

What's explicitly **not** in v0.3:

- ~~Quality-as-merge-gate.~~ Audits are the v0.3 surface for "this
  looks wrong"; gating is v0.4 once we have evidence audits actually
  catch things.
- ~~Auto-prepending doctrine to prompts.~~ Rejected — CLAUDE.md is
  the canonical reference, runs follow it.
- ~~Per-project rubric scoring as a separate thing.~~ Folded into
  audits; rubrics are just a kind of audit.
- ~~Push notifications, in-app prompt editor (Monaco), marinate
  scheduler, weekly digest.~~ All v0.4 ergonomics. The marinate
  scheduler does become v0.4's natural host for *audit cadence* — v0.3
  ships on-demand audits, v0.4 schedules them.

## 6.2 Architectural principle for v0.3 — Factory is a tool, not a gatekeeper of value

Concretely: every per-project artifact (audit skills, audit reports,
vision docs, task files) is reachable and useful **without Factory in
the loop.** The repo is canonical; Factory state is a working surface.

If `~/.factory/data.db` is wiped tomorrow, the project keeps:
- its skills (in `<project>/.factory/audits/`),
- its approved audit reports (in `docs/internal/audits/`),
- its vision (in `docs/internal/VISION.md`),
- its tasks (in `<project>/.factory/work/`),
- its CLAUDE.md.

Factory loses its working state — pending plans, unapproved reports,
in-progress audits. The project does not lose value.

This forces a related principle: **storage seams must remain
extensible without acrobatics.** Tasks are local-md-with-frontmatter
today; a future swap to GitHub Issues or beads should be a one-file
change in `apps/daemon/src/projects/tasks.ts`, not a v0.4 refactor
spread across every flow that creates tasks. v0.3 lands new flows
(bug capture, audit-finding promotion, feature-plan freeze) — all
of them route through the existing task-IO module. Same posture for
audit reports (DB-row + repo-file split is the abstraction; future
"commit to gist" or "post to external doc store" is a provider
swap), audit skills (one loader), and ultimately runs (already done).

## 6.3 v0.4 and beyond — lightly updated

- **Spec foundry** moved from v0.4 to v0.2 as the project-foundry
  instance of the Plan primitive (see ADR-002). v0.4's "compounding"
  framing still applies to *cross-project* concerns — templates,
  reusable plan fragments, project-archetype detection.
- **Audit cadence (marinate scheduler).** v0.3 audits are on-demand.
  v0.4's marinate scheduler hosts cadence: weekly drift-check, monthly
  vision-integrity, etc. Audit kind already wraps the work; the
  scheduler just picks one and submits.
- **Quality-as-gate.** v0.4 makes selected audit kinds (or quality
  checks) blocking on merge for projects that opt in. Requires
  audit-finding-severity to be reliable, which is what v0.3 use
  validates.
- **Cross-project memory** (v0.5) inherits the Plan primitive
  directly — it is "structured back-and-forth that the agent reads on
  warmup," scoped above any single project. Designing the v0.5 memory
  layer on top of v0.2's plan/comment substrate avoids a refactor.

## 7. What's not on any list yet

Worth flagging so they don't become invisible:

- **Idea capture from outside the PWA.** Telegram bot / email-to-inbox is
  already in spec §14, but nothing has been built. If the inbox empties,
  this is the first response.
- **A weekly digest.** What shipped, what stalled, what got trashed. One
  email or PWA card per week. Not on any milestone but cheap and aligned
  with the operator-as-portfolio-manager framing.
- **Rubric self-iteration calibration.** The §13 v0.5 item. Pre-requisite is
  override-pattern logging — and v0.1 already logs operator overrides on
  decisions. Worth surfacing the data even before the iteration mechanic
  exists.
- **Runtime metrics.** Run wall-time, token spend (where derivable), cache
  hit rate. We don't measure today; we'd need this before any "is the
  factory paying for itself" conversation.

## 8. Discipline

Two anti-patterns worth refusing actively:

- **Don't add a second attention sink.** Every notification, every "look at
  this," every dashboard tile competes with the inbox. New surfaces must
  either feed the inbox or live downstream of an explicit operator drill-in.
- **Don't generalize before the second instance exists.** The agent provider
  interface is sized for one provider on purpose. The runtime has one
  sandbox kind. Generalize when a real second instance shows up — and not
  before. The codebase is small enough to refactor, expensive enough to
  over-design.

---

## Appendix — cross-references

- Architectural contracts that v0.1 + v0.2 established: `CLAUDE.md`.
- Original spec backlog: `docs/spec.md` §13.
- v0.1 open questions and dispositions: `docs/adr/001-v01-open-questions.md`.
- v0.2 architectural commit (Plan primitive): `docs/adr/002-plan-primitive.md`.
- v0.2 implementation-ready spec: `docs/spec-v0.2.md`.
- v0.3 architectural commit (Audit primitive): `docs/adr/003-audit-primitive.md`.
- v0.3 implementation-ready spec: `docs/spec-v0.3.md`.
- Milestone playbook (historical): `docs/handoff.md`.
