# ADR-025 · Agent-facing work-creation surface (MCP-first) over the existing ingest

**Status:** proposed (2026-07-21)
**Scope:** a first-class, authenticated surface that lets *external* agents (the
freedom loop, Mabel, the CLI fleet) create Factory work — inject a spec →
decompose → project + task DAG — without a human paste step, while keeping injected
work at the bottom of the trust ladder.
**Full design:** [`../../SPEC-work-creation-surface.md`](../../SPEC-work-creation-surface.md).
**Builds on:** ADR-012 (trust ladder), ADR-014 (verifier gate), ADR-020
(`needs_triage` intake), ADR-021 (task pipeline), ADR-015 (registry/extensibility
discipline). Reuses the spec-import path (`projects/import-spec.ts`).

## Context

Work only enters Factory through the operator (PWA) or the daemon's own proactive
jobs. Ryan's other agents can't create Factory work — they emit *handoff prompts*
(`~/dev/freedom/handoffs/`) a human pastes into a repo. That is a leverage leak: the
estate is MCP-native (Mabel, engram-mcp, aclig.dev, the CLI fleet), and mutating
work that *should* ride Factory's isolation + verifier gate instead rots as prose or
runs in loose worktrees.

Every capability an injected spec needs already exists as bearer-authed tRPC
procedures: `projects.proposeImportSpec` / `confirmImportSpec` (spec → decomposition
→ bootstrap), `projects.tasks.create`, `runs.start`, and the status queries. The
gap is not machinery; it is an **authenticated, agent-shaped front door** that
reuses that machinery without weakening the safety controls.

## Decision

Build an **`factory` MCP server (primary) + a thin CLI (secondary)** as a
**stateless adapter** over the existing procedures, called through the in-process
tRPC caller (`createCallerFactory(appRouter)` — the same entrypoint the integration
tests use). No ingest is forked.

**Tools:** `factory.createProject` (spec → project + DAG), `factory.createTask`,
`factory.getStatus`, `factory.listRuns`, `factory.listProjects`. No run-start,
merge, promote, or autonomy-change tool in v1.

**MCP-first, both** because the estate is MCP-native (one server drives *every*
agent) and the CLI is ~150 LOC over the same client (wraps the handoffs' documented
`factory task create --file`). Both are pure transport adapters; no logic lives in
either.

**Trust posture — the non-negotiable part.** Injected work composes existing
controls; it invents none:

1. **Supervised (L1) + auto-advance off.** The injected path overrides
   `bootstrapProject`'s ceremony-derived defaults to force
   `autonomyMode: "collaborative"` + `autoAdvance: false`. Nothing self-starts.
2. **Intake status, not `ready` (ADR-020).** Injected tasks land at
   `needs_triage`; `isStartable` gates on `ready`, so auto-advance can never pick
   them. The operator promotes deliberately in the PWA — the exact protection built
   for adopted GitHub issues.
3. **Attributable.** `ideas.source = "mcp:<agent>"` + a task `sourceInjection`
   provenance field record who injected what, citing which handoff/commit.
4. **No unattended run — therefore no unattended merge.** The guarantee is at the
   *start* gate, not the merge step. Injected work can't start a run on its own: the
   auto-advance worker only fires for `autonomous` + `autoAdvance` projects
   (`workers/idle-advance.ts`) and `isStartable` gates on `ready`
   (`projects/tasks.ts`), while injected work is collaborative/L1 + `autoAdvance:false`
   with tasks at `needs_triage`. Nothing starts unattended, so nothing merges
   unattended. **Honest caveat:** once the operator promotes and starts a run, a
   `completed` collaborative run **does** merge to `main` (`workers/runner.ts` merges
   unconditionally on `finalStatus === "completed"`); the ADR-014 verifier gate that
   holds a run for review is *autonomous-only*, so it does **not** gate supervised
   injected runs. A true "hold injected runs for review before merge even after an
   operator start" is a **merge-policy change the follow-on build must add**, not
   existing behavior. The trust ladder's upper rungs (L3/L4) remain earned by track
   record, which brand-new injected work never has.
5. **Rate + scope limits.** Per-agent injection quota; a `config.yaml` allowlist of
   injectable repo roots; spec size already bounded by the Zod input.

**Auth.** Loopback-only bind (`127.0.0.1`; stdio + local HTTP/SSE) — a
*work-writing* surface is never on the LAN like the PWA. Callers reuse the daemon's
existing bearer token (`~/.factory/config.yaml`, mode 600) via env/local config;
the secret is never committed. Per-caller tokens are a v2 hardening.

## Consequences

- **The freedom loop stops paste-handing factory work.** `pipeline/run.md` calls
  `factory.createProject`/`createTask` for factory-enabled targets; handoffs for
  those targets become direct injections tracked by `projectId` + `statusUrl`.
  Non-factory (worktree/headless) handoffs are unchanged.
- **Any estate agent can drive Factory** through one MCP, not bespoke glue.
- **Injected work is provably inert until the operator promotes it** — the trust
  ladder and intake gate hold; the operator remains the only path to a repo write.
- **Small, additive build** (~1–1.5 weeks): one safety-override seam in the ingest
  + a thin adapter app + CLI + config/tests. No new engine, executor, or store.

## Alternatives considered

- **CLI-only.** Simpler, but leaves the MCP-native estate unserved and forces
  bespoke per-agent glue — the opposite of the leverage goal. Rejected as primary;
  kept as the secondary transport.
- **Fork a dedicated injection ingest.** Faster to hack, but duplicates the
  `createTask` normalization + run gates and drifts from them over time (exactly the
  divergence ADR-015 forbids). Rejected — reuse the tRPC procedures.
- **Land injected tasks `ready` (like the operator spec-import path).** Convenient,
  but re-creates the ADR-020 "adopted work auto-runs unvetted" bug for *agent*-
  injected work. Rejected — `needs_triage` + operator promotion is the whole point.
- **Expose the surface on the LAN bind (like the PWA).** A work-writing surface on
  `0.0.0.0` widens the attack surface with no benefit. Rejected — loopback only.
