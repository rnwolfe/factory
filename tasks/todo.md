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
- [ ] **Slice 2 — scheduler tick** (`workers/scheduler.ts`, 3rd 60s tick + EventBus, skip-if-inflight).
- [ ] **Slice 3 — synthesis + observations** (`claude --print` over `WorkRecord[]`/`MemoryDoc[]` →
      `watch_observations`; `watch_cursors` + `watch_insight` decision kind; operator-memory repo IO).
- [ ] **Cadence:** backlog grooming; decompose-next-milestone on queue-drain (replace bare
      `queue_empty` at `inbox/queue-empty.ts:53`); scheduled health audits (exercise empty `audits`
      table); doc-drift at release; dependency sweeps → inbox.
- [ ] **Ambient self-generated intake** (Jules Suggestions): read-only repo/issue/error/audit scan →
      proposes own tasks to inbox.
- [ ] **★ Out-of-band-work watcher (operator's enhancement):** periodic read-only pass over the local
      host's `~/.claude/projects/*` + `~/.codex/` history → synthesize work done *outside* Factory
      into memory (patterns, corrections, new conventions/skills); surface "you keep doing X by hand
      — want me to own it?" to inbox. Respect `.env*` deny rules; write ONLY to memory + inbox, never
      a repo. Memory becomes Factory-earned, not operator-curated.

## Cross-cutting guardrails (every WS honors)

- Operator is the only path to a repo write (VISION/ADR-004 §9) — autonomy expands via read-mostly +
  low-risk-write auto-approval gated on verifier confidence, never by removing merge/approve gates.
- Unattended-run guardrails: no force-push, `main` via PR only, no prod restarts, no long-lived
  processes, no scope invention, auditable trail.
- Suggest a release after each coherent operator-visible WS lands.
