# Factory autonomy — workstream tracker

North-star: **decisions-per-run → 0** while auto-merge stays ~99% and failures stay flat.
Reference: `docs/research/2026-06-27-autonomous-proactive-factory.md`.
ADRs: 010 (The Watch), 011 (Watch work-generator), 012 (Trust Ladder).

## Interface-discipline pass (ADR-015) — registry as the single touch-point

Goal: adding an agent family OR a task backend = one impl + one registration; no site
branches on a literal id.
- [x] **Agents — enum + cross-model + consumers** (landed): `AGENT_NAME_ENUM` (5 routers),
      `validatorAgentId` (cross-model, kills `OTHER_FAMILY`), `runtimeSpecFor` (runner no longer
      special-cases claude-code), `authGuideText` (submit), `recover.ts` uses the agent's own
      `parseLine`.
- [x] **Task backends — interface fold + registry** (landed): `TaskStore` now covers
      discussion/adopt/reply; the 7 standalone `*Issue*` functions are thin dispatchers (no
      `taskBackend` branch); `taskStoreFor` is a `registerBackend` registry.
- [ ] **Shared `@factory/agent-config` package** so `apps/cli/doctor.ts` iterates the registry's
      `probeAuth` instead of a hardcoded codex check (already a documented deferral in registry.ts).
- [ ] **Task backend config-blob**: `githubRemote`/`githubInstallationId` → a generic
      `backendConfig` JSON column (+ migration). Columns work today; this is elegance/decoupling.
- [ ] **Cosmetic type-only**: PWA `AgentName` union + `sessionMode` derive from the registry
      (no runtime impact; PWA already reads descriptors via tRPC).

## Shipped (2026-06-27 → 28)

- ✅ **WS0 — `bun test` self-kill fix** → released **v0.30.1**. Root cause: no private tmux socket
  (+ Bun env-snapshot gotcha); fix = `-L` socket via `FACTORY_TMUX_SOCKET`.
- ✅ **The Watch substrate (ADR-010, on `main`)** — pluggable `HarnessSource` (claude-code/codex),
  scheduler tick + operator-tunable `watch-synthesis-cadence`, `claude --print` synthesis → deduped
  `watch_observations` → `watch_insight` inbox cards (adopt-as-task/acknowledge/dismiss). Live smoke
  produced 3 high-signal observations.
- ✅ **Trust Ladder Slice 1 — L2 auto-ratify (ADR-012)** — new `auto_ratified` status; uniform fork
  emission (retired the lossy "don't emit" footer); L1 pending / L2 auto-ratified; **override
  preserved** (the safety valve); PWA chip + override-from-history.

> Branch `feat/watch-generator` holds ADR-011 + ADR-012 + Trust Ladder Slice 1 (unmerged). The Watch
> substrate is on `main`. Pending release decision: batch as **v0.31.0** ("The Watch + Trust Ladder L2").

---

## ★ WS-METRICS — Autonomy & ops observability  *(operator directive 2026-06-28; first-class, historical)*

Cross-cutting principle: **every autonomy feature emits its effectiveness metric as it lands.**
EXTEND the existing surface — `routers/ops.ts` (live runs, activity, usage windows), `routers/metrics.ts`
(agent cost/tokens), PWA `ops.tsx`/`metrics.tsx` — don't reinvent. Keep it **read-only** (VISION:
"a complementary operational-awareness layer that doesn't become a second inbox").

- [ ] **ADR-013 — metrics & ops surface** (design first, per the dashboard-in-flux caution): time-series
      storage (daily rollups vs compute-on-read), chart components, historical range, per-project +
      portfolio rollups.
- [ ] **Autonomy-effectiveness metrics:** decisions-per-run (north-star, over time); auto-ratify rate &
      override rate (Trust Ladder health); self-proposed (Watch) tasks created → completed → merged;
      projects at each autonomy level; autonomous chain depth (avg/max).
- [ ] **Operational metrics (standing gap, not autonomy-adjacent):** throughput (runs/day, completed/day);
      active projects under management; commit rate per-project + total; **LOC shipped** (added/removed)
      per-project + total; auto-merge rate; failure rate.
- [x] **First-class historical charting** (v0.32.0/v0.33.0) — Recharts time-series + the Watch
      observability panel, on both /ops and /metrics.
- [ ] **★ IA cleanup — ops vs metrics discernment** (deferred, operator-flagged 2026-06-28). The
      autonomy charts + Watch panel were mounted on BOTH /ops and /metrics without discernment.
      Differentiate by surface identity: historical time-series → /metrics; current operational state
      (Watch loop status, live tiles) → /ops. Remove the duplication. See tasks/lessons.md.

## Trust Ladder (WS A) — remaining

- [~] **Slice 2 — auto-movement (core landed)** — `workers/trust-ladder.ts`: `evaluateTrustOnOutcome`
      contracts autonomous→collaborative on a run **failure / merge conflict** (wired in the runner)
      and on an **operator override of an auto-ratified fork** (wired in `overrideAgentDecision`);
      `maybeAutoPromote` ratchets collaborative→autonomous after **N=5** consecutive clean
      (completed + verifier-`high`) runs. `needs_review` (gate-held) is neutral. 11 tests.
  - [ ] **Surfacing follow-up**: push notification on a move ("project X paused/earned …") + a
        level/trend chip in the project header (today the move is logged + reflected in the mode
        picker, but the operator isn't actively notified).
- [ ] **Slice 3 — L3 bounded auto-retry** of *transient* `blocked_run` / `merge_failure` with an
      operator-visible retry budget that escalates on exhaustion (never the structural human blocks).
- [ ] **L4** = Watch-generated work auto-runs (= ADR-011 Phase C), gated by WS C.

## WS C — Verifier-Coverage Gate  *(prereq for Trust Ladder step-up + L4)*

- [~] **Slice 1 — the verifier-confidence score (landed, informational).** ADR-014 + `verifier.ts`
      (`computeVerifierReport`): three-state coverage (pass/fail/**absent**) over acceptance + quality,
      weighted score + level (none/low/medium/high). `absent` = 0 → a "completed" run that nothing
      checked scores `none`. Computed at completion, persisted on `runs.verifier_report` (migration
      0035). Changes NO routing yet (mirrors quality v0.2→v0.3). Cross-model joins as a signal (WS D).
  - [x] **Slice 2 — the gate (landed)**: `classifyBlastRadius` (churn/files/risk-sensitive paths) +
        `decideAutoLand` (land only on **high** coverage + **contained** diff). Wired for
        AUTONOMOUS runs only: a completed run that fails the gate is downgraded to `needs_review`
        (reuses the existing not-merged/surface-for-review path; collaborative = unchanged v0.1).
  - [x] **Slice 3 — freeze precondition (landed)**: freezing a `task_plan` on an AUTONOMOUS
        project now requires ≥1 testable acceptance criterion (PRECONDITION_FAILED otherwise,
        like the vision filter). Closes the `absent` case at its source — autonomy-eligible work
        can't freeze without something for the verifier to check. **WS C complete.**
  - [x] **PWA** (landed): `verifier-report.tsx` — level chip + three-state per-signal coverage
        (pass ✓ / fail ✗ / absent "— not covered"), mounted by the live pane next to quality.
- [x] **WS D — cross-model validation** (landed): `cross-model.ts` routes verification to the
      OTHER family (claude↔codex) one-shot via `invokeClaudeJson` (family-agnostic, no new auth);
      verdict (pass/concerns/fail + confidence) becomes the `cross-model` signal, conditionally
      re-weighting the score. Gated to autonomous-mode runs (full second-model call). Renders in
      the verifier panel automatically. (Per-project/global opt-out toggle = a refinement.)

## The Watch as work generator (ADR-011) — remaining

- [~] **Phase A — typed proposals + promotion paths.** bug→task ✓ (3c adopt-as-task);
      **feature→drafting plan ✓** (`draft-feature-plan` → `seedFeaturePlanDraft` + plan insert, PWA
      card; synthesizer reframed as work-generator w/ precision bias, note-only = residual). Promote
      ONLY through each primitive's single-source-of-truth seam (held). Remaining Phase A slices:
  - [ ] **arch→audit** (`propose-audit`) — needs audit-skill selection (which skill to run).
  - [ ] **project→triage** (`propose-project` → `runTriage` → `project_spec` draft).
  - [x] **backlog-groom** (landed) — `groom-backlog` proposal carries `targetTaskId`; approve closes
        the task via `updateTaskStatus(... "dropped")`. Produced by the stale-backlog detector below.
        (Re-prioritize variant still open — needs a task-priority seam.)
  - [x] **backlog-aware dedup** before surfacing (landed) — `watch/inband/backlog.ts`
        (`filterAlreadyTracked`) drops project-scoped work proposals already in the target project's
        open tasks / active plans; wired into the synthesis job before persist/surface. Precision
        contract honored (operator-level / notes / unknown-project all pass through).
- [~] **Phase B — in-band sources + cadence/groom jobs.** Landed: the backlog reader (consumed by
      dedup); an **in-band detector registry** (`watch/inband/detectors.ts`, registry discipline) +
      the **in-band groom job** (`createInBandGroomJob`, own scheduler entry, shares dedup+surface,
      no LLM); detectors **run-failures** (3 consecutive failed runs → candidate-task) and
      **stale-backlog** (ready task idle >30d → groom-backlog → close). Remaining detectors:
      stale-audit → propose-audit, repeated error-signature across runs, repo git-drift. Plus cadence
      jobs: decompose-next-milestone on queue-drain, scheduled health audits, doc-drift sweeps. (Own
      cadence setting still one knob.)
- [ ] **Phase C — generation → gating.** Route generated work through WS C + the Trust Ladder (depends on A + C).

## ★ Operator-memory repo + viewer (ADR-010 §4)

- [x] `operator-memory.ts` (landed): **fresh, Factory-owned** git repo (default
      `<FACTORY_HOME>/operator-memory`), Claude-format (`MEMORY.md` index + per-fact frontmatter
      files); ensure/write/list/read-index (one commit per write, index rebuilt from disk).
- [x] **First-class PWA viewer** (landed): its own `/memory` route + sidebar nav, facts grouped by
      type, expandable body + provenance chips, empty state. Read-only.
- [x] **`record-as-convention` write** (landed): approving a `watch_insight` writes the convention
      into the repo (operator-gated, best-effort, with provenance).
- [x] **Seed: synthesize-from harness memories, settings-triggered** (landed). `memory/seed.ts` +
      `memory.seed` mutation (background, re-runnable) + a settings "Seed from harness memories"
      button. Synthesis-not-copy; not auto-on-boot. (Synthesis cadence-as-setting still open.)
- [~] **Blanket run injection — REMOVED (over-corrects cross-project).** The `contextRefs` wrapPrompt
      seam + `operatorMemoryPointer` helper are kept, but runner no longer points every run at all
      operator memory (operator flagged: cross-project insight bleeds projects the wrong way). Memory
      reaches work via the two scoped channels below instead. See tasks/lessons.md.
- [ ] **(a) Memory → gated proposals.** Synthesized insight derives proposed tasks / bugs / process &
      routine improvements (operator-gated — the Watch generator, ADR-011). Propose, don't steer.
- [ ] **(b) Hone a given project.** Project-scoped direction (project-level `record-as-convention` →
      that project's AGENTS.md / scoped conventions), so only project-relevant direction reaches it.

## Backlog from the report (not yet scheduled)

- [ ] **Provisioning manifest** — anticipate `blocked_run` (secrets/hardware/verdicts) at plan-freeze,
      batched into one pre-flight decision instead of N mid-run stalls.
- [ ] **Overnight mode as a first-class run contract** (no force-push, main-via-PR, no prod restarts, no
      scope invention, morning report) — promote the `overnight-run` skill.
- [ ] **Backlog-pull fleet** — widen `pool.ts` FIFO-of-4 → prioritized cross-project pull + fairness/locks.
- [ ] **Execution-evidence on merge** + lessons-as-context loop + credential hardening (microsandbox-style).

## Guardrails (every workstream)

- Operator is the only path to a repo write (VISION/ADR-004 §9) — autonomy expands via read-mostly +
  low-risk-write auto-approval gated on verifier confidence; never remove merge/approve gates wholesale.
- Inbox stays the only attention sink; the ops/metrics surface is **read-only**.
- Suggest a release after each coherent operator-visible batch.
