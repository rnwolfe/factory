# Autonomous & Proactive Factory — build plan

Derived from `docs/research/2026-06-27-autonomous-proactive-factory.md`. Operator approved all four
threads (2026-06-27). Build order respects dependencies: **bug fix unblocks chains → A cuts the
inbox → C makes A defensible → B adds the proactive layer.** Each substantial feature gets its own
ADR + spec delta per repo convention before code.

North-star metric: **decisions-per-run → 0** while auto-merge stays ~99% and failures stay flat.
(Prior `tasks/todo.md` — completed task-064, inbox resurfacing — is in git history.)

---

## WS0 — Fix the `bun test` self-kill bug  ✅ DONE (2026-06-27)

Caused ~85% of all failures and severed ~half of all autonomous chains.

**ROOT CAUSE (confirmed empirically — twice reproduced live, even killing this dev session):**
Factory never isolated its tmux onto a private socket, so the parent `claude --print` pane, the
daemon's sessions, and the daemon test suite's **real** tmux sessions all shared the one default
tmux server. Two wide-only test files (`sessions-orchestrate` / `interventions-orchestrate`) churn
real create/`kill-session` on that shared server, destabilizing it and killing the co-tenant parent
pane → no factory-status footer → `failed`. The CLAUDE.md session-name-collision guess was wrong;
it's server/socket-level. **Critical gotcha discovered during the fix:** Bun snapshots a child's
env at spawn, so an env-only fix (unset `$TMUX` / set `TMUX_TMPDIR` in-process) does NOT reach the
spawned tmux — verified directly. The isolation lever must be a **CLI arg computed in-JS**.

- [x] **Fix:** `tmuxSocketArgs()` in `packages/runtime/src/tmux.ts` returns `["-L", FACTORY_TMUX_SOCKET]`
      when the env var is set (else `[]`). Wired into the `tmux()` helper + the 3 raw `bunSpawn(["tmux"…])`
      kill-session sites (`workers/recover.ts`, `interventions/orchestrate.ts`, `routers/runs.ts`).
      Production-identical (env unset → no flag).
- [x] **Test isolation:** both integration suites set `FACTORY_TMUX_SOCKET=factory-test-<pid>-<n>` in
      setup (restored in cleanup) and tear down their private server via `tmux -L <socket> kill-server`.
- [x] **Verified safely** (staged stand-in parent on a private socket, `$TMUX` faked to it = the
      agent-pane scenario): broken env-version killed the parent; `-L` version → parent survives.
      Full daemon suite **363 pass / 0 fail** (59 files) with the parent pane intact. typecheck +
      biome clean (2 pre-existing warnings only).
- [x] Updated AGENTS.md "wide `bun test`" contract note to reflect the fix.
- [ ] **Follow-up (operator):** confirm on the live host under a real self-hosting run, then this
      note can drop entirely. Optional hygiene: set `FACTORY_TMUX_SOCKET` for the daemon too so
      live/dev instances also get isolated tmux servers (not needed for the bug; nice-to-have).

## WS A — The Trust Ladder  *(biggest single inbox cut; plumbing exists)*

- [ ] ADR: `autonomyMode` enum → graduated L1–L4 (Operator/Collaborator/Approver/Observer).
- [ ] **Fix latent bug first:** autonomous mode does NOT actually suppress `agent_decision`
      (backbar/backlot went through collaborative flow in prod data). Make the footer-swap +
      `decisionsEnabled` path (`runner.ts:351`, `factory-status.ts:415-434`) auto-resolve forks.
- [ ] L2: agent auto-resolves `agent_decision` to "most defensible path," posts chosen fork +
      reasoning as inbox `notify` (not `review`). Seam: `workers/agent-decisions.ts`.
- [ ] Auto-movement: ratchet level up after N consecutive clean verifier-green auto-merges; contract
      immediately on failure / merge conflict / operator override. Read track record from `runs`.
- [ ] PWA: surface level + trend in project header beside TierPicker.
- [ ] L3/L4 deferred behind WS C + WS B.

## WS C — The Verifier-Coverage Gate  *(makes widening the ladder defensible)*

- [ ] ADR: verifier-confidence score as autonomy-eligibility signal.
- [ ] Compose from existing signals: factory-status `done` + all acceptance criteria met
      (`runner.ts:530`) + quality green (`quality.ts`) + cross-model validation (WS D).
- [ ] Frozen testable acceptance criteria = **freeze precondition** (no criteria → not eligible).
- [ ] Diff reversibility/blast-radius → routing: high+contained → auto-land; low → `review`.
- [ ] **WS D (fast-follow, near-free):** cross-model adversarial validation — route verification to
      the *other* family (claude↔codex) via existing AgentModelPicker resolution.

## WS B — The Watch  *(reactive→proactive flip; the Heimdall thesis)*

- [x] **ADR-010 drafted** (`docs/adr/010-the-watch.md`). Findings baked in: the v0.4
      `scheduler.ts` **never shipped** (build it fresh as a 3rd tick alongside
      `usage-cap.ts`/`inbox-resurface.ts`); harnesses sit behind a pluggable `HarnessSource`
      registry mirroring `agents/registry.ts` (no consumer branches on source id); Factory has
      **no memory primitive** today, so observations index in the DB and promote into
      repo-canonical artifacts (tasks / AGENTS.md), operator-gated. Decisions folded in:
      operator-memory repo is **fresh + Factory-owned by default** (synthesizes new knowledge,
      not a mirror), **first run ingests all harness memories** as input, and the repo is
      **first-class viewable in the PWA**.
- [x] **Slice 1 — pluggable `HarnessSource` (landed).** `apps/daemon/src/watch/sources/`:
      `types.ts` (interface + `WorkRecord`/`WatchCursor`/`MemoryDoc`), `registry.ts`
      (`HARNESS_SOURCE_REGISTRY`, mirrors `agents/registry.ts`), `claude-code.ts` + `codex.ts`
      (read-only incremental `scan(cursor)` + `readMemories()`, skip `.env*`), `fs-util.ts`.
      6 tests pass; validated against real `~/.claude` (32 recent sessions, 83 memory docs) and
      `~/.codex` (ts=epoch-seconds confirmed). No LLM/scheduler/DB yet — pure pluggable foundation.
- [x] **Slice 2 — scheduler tick (landed).** `workers/scheduler.ts`: generic 3rd 60s tick +
      EventBus, time-cadence + event jobs, **skip-if-inflight**, injectable clock + `runDue(at)` for
      deterministic tests. `watch/synthesis-job.ts`: the out-of-band job (scan-only; synthesis is
      slice 3), bounded cold-start lookback, per-source in-memory cursors. **Cadence is an
      operator-tunable setting** `watch-synthesis-cadence` (`off|hourly|daily|weekly`, default daily,
      read live each tick — no restart), validated in the settings router. Wired in `index.ts` +
      shutdown. 7 tests; full daemon suite 376 pass.
- [x] **Slice 3a — schema + durable cursors (landed).** `watch_cursors` + `watch_observations`
      tables (migration `0033`), enums (`watchObservationKind/Proposal/Status`). `watch/cursor-store.ts`
      (DB-backed + in-memory), wired into the synthesis job + daemon boot so scans resume across
      restarts. 2 tests incl. fresh-instance-resumes-from-store. Full suite 378 pass. (`watch_insight`
      decision kind deferred to 3c so the enum + its PWA card handler move together.)
- [x] **Slice 3b — the synthesizer (landed).** `watch/synthesize.ts` (`claude --print` over
      `WorkRecord[]` + first-seen `readMemories()` → `RawObservation[]`; injectable invoke; fenced
      JSON + null-parse-fail; validation drops bad kind/proposal/evidence). `watch/observation-store.ts`
      (dedupeKey + insert-once into `watch_observations`). Job rewired: scan→synthesize→save, cursors
      committed only after success (failed turn re-scans, dedup-idempotent). Wired real synth+save at
      boot. 6 tests; full suite 384 pass. NOT yet surfaced to the operator (that's 3c).
- [x] **Slice 3c — inbox surfacing (landed).** `watch_insight` decision kind; `watch/observation-inbox.ts`
      surfaces new observations as notify-grade inbox decisions (resolves slug→project, flips obs to
      `surfaced`); boot edge composes persist→surface. `decisions.action` handles approve (adopt-as-task
      → `createTask` when proposal+project, else acknowledge → obs `adopted`) and dismiss (obs
      `dismissed`). PWA `watch_insight` card across decision-card / inbox-detail-pane / decision-detail /
      history (adopt-as-task|acknowledge + dismiss buttons, dispatcher's-console aesthetic). 8 new tests
      (surfacing, action approve/dismiss, PWA components). Full repo green: daemon 388, pwa 20, all
      typecheck. **First operator-visible payoff — insights now appear in the inbox.**
### Reframe → ADR-011: The Watch as a proactive **work generator** (2026-06-27)

Strategic pivot (operator-raised): surfacing reflective insight is the *learning
substrate*, not the autonomy lever. Autonomy moves when The Watch emits **typed work**
mapped to Factory's primitives, fed by out-of-band AND in-band signal, with a gated path
to auto-execution. Substrate (3a–3c, merged) carries forward; remaining work re-sequenced
into ADR-011 phases (these now precede the operator-memory polish):

- [ ] **Phase A — typed proposals + promotion paths.** Extend the proposal taxonomy
      (bug→task ✓ via 3c; + feature→drafting plan, arch→`audits.submit`/promote-finding,
      project→triage `project_spec`, backlog-groom→task close/reprioritize). Promote ONLY
      through each primitive's existing single-source-of-truth seam — never reimplement.
- [ ] **Phase B — in-band sources + cadence/groom jobs.** Generalize the source registry
      to **signal sources** (runs/decisions/audits/task-backlog/repo state) alongside
      harness sources. Fill the scheduler with ADR-010 §1 cadence jobs: backlog grooming,
      decompose-next-milestone on queue-drain (replace bare `queue_empty` at
      `inbox/queue-empty.ts:53`), scheduled health audits, doc-drift/dependency sweeps.
- [ ] **Phase C — generation → gating (the actual autonomy).** Route generated work
      through WS C (Verifier-Coverage gate) + WS A (Trust Ladder): high-confidence /
      low-blast-radius / verifiable → auto-run; ambiguous / judgment-heavy / irreversible →
      inbox. Surface-first always; auto-run graduates per earned trust. **Depends on WS A + C.**
- [ ] **Fast-follow — operator-memory repo** (`operator-memory.ts`: fresh Factory-owned git
      repo, Claude-format; first run ingests all harness memories; injectable as run context)
      + **PWA viewer**. The learning half (ADR-010 §4); makes `record-as-convention` fully
      functional. No longer blocks the generator.

Open questions in ADR-011 §"Open questions" (generation aggressiveness / per-project opt-in;
feature_plan promotion = seed-vs-draft; backlog-aware dedup; in-band scan cost).

## Cross-cutting guardrails (every WS honors)

- Operator is the only path to a repo write (VISION/ADR-004 §9) — autonomy expands via read-mostly +
  low-risk-write auto-approval gated on verifier confidence, never by removing merge/approve gates.
- Unattended-run guardrails: no force-push, `main` via PR only, no prod restarts, no long-lived
  processes, no scope invention, auditable trail.
- Suggest a release after each coherent operator-visible WS lands.
