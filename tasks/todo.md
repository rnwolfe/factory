# Factory autonomy — workstream tracker

North-star: **decisions-per-run → 0** while auto-merge stays ~99% and failures stay flat.
Reference: `docs/research/2026-06-27-autonomous-proactive-factory.md`.
ADRs: 010 (The Watch), 011 (Watch work-generator), 012 (Trust Ladder).

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
- [ ] **First-class historical charting** in the PWA ops surface — per-project + portfolio, time-series,
      not just current snapshots.

## Trust Ladder (WS A) — remaining

- [ ] **Slice 2 — auto-movement** (turns the switch into a ladder). Track-record ratchet (N consecutive
      clean verifier-green outcomes → step up) + **auto-contract** on a run failure / merge conflict /
      **override of an auto-ratified fork**. Surface level + trend in the project header. *(Step-up's
      "verifier-green" signal depends on WS C.)*
- [ ] **Slice 3 — L3 bounded auto-retry** of *transient* `blocked_run` / `merge_failure` with an
      operator-visible retry budget that escalates on exhaustion (never the structural human blocks).
- [ ] **L4** = Watch-generated work auto-runs (= ADR-011 Phase C), gated by WS C.

## WS C — Verifier-Coverage Gate  *(prereq for Trust Ladder step-up + L4)*

- [ ] ADR + verifier-confidence score: factory-status `done` + all acceptance criteria met
      (`runner.ts:530`) + quality green (`quality.ts`) + cross-model validation. Frozen testable
      acceptance criteria = **freeze precondition**. Diff reversibility/blast-radius → routing
      (auto-land vs review).
- [ ] **WS D — cross-model validation** (near-free): route verification to the *other* family
      (claude↔codex) via the existing AgentModelPicker resolution — strongest input to the score.

## The Watch as work generator (ADR-011) — remaining

- [ ] **Phase A — typed proposals + promotion paths.** bug→task ✓ (3c adopt-as-task); + feature→drafting
      plan, arch→`audits.submit`/promote-finding, project→triage `project_spec`, backlog-groom→task
      close/reprioritize. Promote ONLY through each primitive's existing single-source-of-truth seam.
- [ ] **Phase B — in-band sources + cadence/groom jobs.** Generalize the source registry to **signal
      sources** (runs/decisions/audits/task-backlog/repo state). Fill the scheduler with ADR-010 §1
      cadence jobs: backlog grooming, decompose-next-milestone on queue-drain, scheduled health audits,
      doc-drift/dependency sweeps.
- [ ] **Phase C — generation → gating.** Route generated work through WS C + the Trust Ladder (depends on A + C).

## ★ Operator-memory repo + viewer (ADR-010 §4) — fast-follow *(don't lose track)*

- [ ] `operator-memory.ts`: **fresh, Factory-owned** git repo, Claude-format (`MEMORY.md` index +
      per-fact files); **first synthesis run ingests all harness memories** as input; injectable as run context.
- [ ] **First-class PWA viewer** of the memory repo (browse `MEMORY.md` + each fact w/ provenance) — read-only.
- [ ] Wire `record-as-convention` promotion (from a `watch_insight`) to write into it (operator-gated).

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
