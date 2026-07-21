# SPEC · Agent-facing work-creation surface (MCP + thin CLI)

**Status:** draft for sign-off (2026-07-21)
**Kind:** spec (this doc). Follow-on: one mutating build task (§9), gated on operator sign-off.
**Companion ADR:** [`docs/adr/025-work-creation-surface.md`](./docs/adr/025-work-creation-surface.md) — the surface-choice decision + trust posture.
**Read first:** `AGENTS.md`, `docs/spec.md`; `docs/adr/012-trust-ladder.md`, `docs/adr/014-verifier-coverage-gate.md`, `docs/adr/020-triage-intake-status.md`, `docs/adr/021-task-pipeline.md`, `docs/adr/015-harness-and-backend-extensibility.md`.

## 1. Problem & goal

Today, **the only way work enters Factory is through the operator** — a human drives
the PWA (triage approve, spec-import, task create, run start) or the daemon's own
proactive machinery (the Watch, issue intake). External agents in Ryan's estate
(the freedom loop, Mabel, the CLI fleet) cannot create Factory work; they emit
*handoff prompts* that a human then pastes into a repo (`~/dev/freedom/handoffs/`,
run via `pipeline/run.md`). That is the leverage leak this spec closes.

**Goal:** a first-class, authenticated, agent-facing surface that lets a trusted
external agent **inject a spec and have Factory decompose it into a project + task
DAG and (optionally) run it** — reusing the existing ingest end-to-end, entering at
the *bottom* of the trust ladder, and never auto-merging freshly-injected work.

**Non-goals:** no new decomposition engine, no new run executor, no new task store,
no weakening of the verifier gate / trust ladder / `needs_triage` intake. This
surface is a **thin authenticated adapter over procedures that already exist.**

## 2. The existing ingest (what we reuse verbatim)

Everything an injected spec needs already exists as tRPC procedures on the daemon,
served at `POST /trpc/*`, bearer-authed by `config.auth.token` (`apps/daemon/src/auth.ts`,
`apps/daemon/src/trpc.ts` `protectedProcedure`). The relevant seams:

| Capability | Existing procedure | Underlying module |
|---|---|---|
| Spec → draft decomposition (pure compute, no rows) | `projects.proposeImportSpec` | `projects/import-spec.ts` `proposeImportSpec` → `spec-decompose-v1` prompt |
| Confirm → bootstrap project + write `SPEC.md` + create task files | `projects.confirmImportSpec` | `import-spec.ts` `confirmImportSpec` → `bootstrap.ts` + `createTask` seam |
| Add one task to an existing project | `projects.tasks.create` | `projects/tasks.ts` `createTask` (normalizes acceptance + `blockedBy`) |
| Promote intake → runnable | `projects.tasks.markAllReady` / `updateStatus` | `tasks.ts` |
| Start a run for a task/prompt | `runs.start` | `workers/submit.ts` `submitRun` |
| Status / DAG / run list | `projects.get`, `projects.tasks.list`, `runs.list`, `runs.get` | routers |

**Design rule (ADR-015 registry discipline):** the surface calls these through the
in-process **tRPC caller** (`createCallerFactory(appRouter)`) — the same entrypoint
the integration tests use (`tasks-drop.integration.test.ts`). No procedure is
forked, reimplemented, or bypassed; every safety normalization at `createTask`
(guaranteed `## Acceptance`, `blockedBy` cleaning) and every run gate
(factory-status footer, verifier report, auto-merge-on-green) applies unchanged.

## 3. Surface choice — MCP-first, thin CLI second

**Decision: build both, MCP as the primary.** Rationale:

- **The estate is MCP-native.** Mabel, engram-mcp, aclig.dev and the CLI fleet are
  built to drive MCP tools. An `factory` MCP server lets *any* of Ryan's agents
  create Factory work with zero bespoke glue — the freedom loop is just the first
  caller. This is the highest-leverage shape.
- **A thin CLI wraps the same tRPC caller** for shell/cron contexts and for the
  handoffs' documented-but-nonexistent `factory task create --file <prompt>`
  (`handoffs/README.md`). The CLI is ~150 LOC over the MCP's client — same calls,
  different transport — so "both" is cheap.
- Both are **stateless adapters**: MCP tool handler / CLI command → tRPC caller →
  existing procedure. No business logic lives in either.

**Where it runs.** The MCP server is a new small entry in `apps/` (e.g.
`apps/mcp`) that the daemon process hosts (or that runs beside it and talks over
the loopback tRPC HTTP endpoint). Hosting it *in* the daemon is preferred: it gets
the in-process tRPC caller (no network hop, no second auth surface) and shares the
`DaemonContext`. It is exposed over **stdio** (for locally-spawned agent clients)
and/or a **loopback HTTP/SSE MCP transport** bound to `127.0.0.1` — never the LAN
bind the PWA uses, because this surface *writes work*, not just reads it (§6).

## 4. Tool list (the MCP surface)

Five tools. Each maps 1:1 onto an existing procedure; the mapping column is the
whole implementation.

| MCP tool | Purpose | Maps to |
|---|---|---|
| `factory.createProject` | Inject a **spec** → new project + task DAG (decompose + bootstrap). The headline capability. | `projects.proposeImportSpec` then `projects.confirmImportSpec` |
| `factory.createTask` | Inject **one task** into an existing project (freeform body + acceptance). | `projects.tasks.create` |
| `factory.getStatus` | Project/task/run status by id — DAG state, lane, run outcomes. | `projects.get` + `projects.tasks.list` + `runs.get` |
| `factory.listRuns` | Recent runs for a project (id, status, verifier level, merge state). | `runs.list` |
| `factory.listProjects` | Discover injectable target projects (slug, id, ceremony, backend). | `projects.list` |

Deliberately **omitted from v1:** any tool that *starts* a run, *merges*, promotes
`needs_triage → ready`, or changes autonomy level. Those stay operator-only for
injected work (§5). Running injected work is the operator's deliberate act via the
PWA, or a later, separately-gated tool once the trust story is proven.

### 4.1 `factory.createProject` — input & return contract

**Input:**
```jsonc
{
  "title": "string (optional; spec may lead with its own)",
  "spec": "string — full spec markdown, verbatim. Freeform OR the plan-project-spec-v1 shape.",
  "targetRepo": {                    // optional; omit → Factory bootstraps a fresh repo
    "kind": "path" | "url" | "new",
    "value": "/abs/path | git url | new-repo-slug"
  },
  "ceremony": "tinker | personal | shared | production",   // default: personal
  "role": "owner | contributor",                            // default: owner
  "constraints": ["string", "..."],  // appended to the spec as a Constraints section
  "attribution": {                    // WHO is injecting — required (§5.3)
    "agent": "freedom-loop | mabel | fleet-cli | <caller id>",
    "ref": "handoff slug / commit / run id"
  }
}
```
The `spec` string is passed **verbatim** to `proposeImportSpec` → the
`spec-decompose-v1` prompt, which already accepts freeform prose *or* a
milestone-structured spec and emits `{title, summary, tasks[], unknowns[], risks[],
firstTaskNote, milestones[]}`. Constraints are folded into the spec markdown before
decomposition so they become task acceptance, not lost metadata.

**Return (the status handle):**
```jsonc
{
  "projectId": "cuid",
  "slug": "kebab-project",
  "specPath": "docs/internal/SPEC.md",
  "tasks": [ { "id": "task-001", "title": "...", "status": "needs_triage",
              "blockedBy": ["task-000"], "estimate": "medium" } ],   // the DAG
  "unknowns": ["..."], "risks": ["..."],
  "statusUrl": "http://<daemon>/#/projects/<id>",   // operator review deep-link
  "trustLevel": "L1", "autoAdvance": false           // proof of supervised entry
}
```

### 4.2 Two-call vs one-call decompose

`proposeImportSpec` is **pure compute** (returns a draft, creates no rows);
`confirmImportSpec` bootstraps. For an *unattended* injector there is no human to
review the draft between the two, so `factory.createProject` **chains them in one
tool call**: propose → (optionally) surface the draft in the return → confirm. The
safety guarantee that replaces the human's review is that the confirmed project
lands **supervised and non-startable** (§5) — the operator reviews *after* landing,
via `statusUrl`, exactly as they review any `needs_triage` intake. This preserves
the "operator is the only path to a repo write" contract (ADR-012) without forcing a
synchronous human in the injection path.

## 5. Safety — injected work enters at the bottom of the ladder

This is the load-bearing section. Four guarantees, each mapped to an existing
mechanism so we are *composing* controls, not inventing them.

### 5.1 Supervised autonomy, no auto-advance
`confirmImportSpec` today calls `bootstrapProject`, which defaults
`autoAdvance: true` and (for `tinker`) `autonomyMode: "autonomous"`
(`bootstrap.ts`). For injected work this is wrong. The surface **overrides both**:
injected projects are created with `autonomyMode: "collaborative"` (trust ladder
**L1**, ADR-012) and `autoAdvance: false`, regardless of ceremony. No run chains
itself; nothing starts without an explicit operator action.
*Build note:* `confirmImportSpec`/`bootstrapProject` need an `injected: true` (or
`autoAdvance`/`autonomyMode` override) param — a small, additive seam change.

### 5.2 Intake status, not `ready` (ADR-020)
Injected tasks are created at **`needs_triage`** (or `backlog`), never `ready`.
`isStartable` gates on `ready`, so auto-advance can never pick injected work — the
exact protection ADR-020 built for adopted GitHub issues, reused verbatim. The
operator promotes `needs_triage → backlog → ready` deliberately in the PWA (the
existing "mark ready" control) after reviewing the spec and the DAG. Until then the
work is **inert but tracked**.
*Build note:* `createTask`'s default status is `ready`; the injected path must pass
`status: "needs_triage"`. (`confirmImportSpec` currently bootstraps tasks as `ready`
via the payload — this is the one behavioral change the build must make for the
injected path, leaving the operator-driven spec-import path untouched.)

### 5.3 Attributable to the injecting agent
Every injected project and task records **who injected it**. Reuse the existing
provenance seams: `ideas.source` already carries `"spec-import"` — injected work
uses `source: "mcp:<agent>"` (e.g. `mcp:freedom-loop`), and tasks carry a
`sourceInjection` provenance field (the `createTask` seam already threads
`sourcePlanId`/`sourceAuditId`/`sourceDecisionId`; this is one more). The
attribution + `ref` land in the synthesized idea's `rawText` and the decision
payload, so the audit trail answers "which agent asked for this, citing what" for
every injected artifact.

### 5.4 Verifier gate + no auto-merge for fresh external work
When the operator *does* promote injected work to `ready` and start a run, it goes
through the **unchanged** pipeline: factory-status footer (`done|blocked|failed`,
null-parse → `failed`), the verifier-coverage report (ADR-014: `absent ≠ pass`;
zero coverage → not autonomy-eligible), quality checks, and per-run worktree
isolation. Because the project sits at **L1 + auto-advance off**, there is **no path
to auto-merge for freshly-injected work** — merge-on-green still requires
`completed`, and the trust ladder's upper rungs (L3/L4 auto-retry / auto-run) are
*earned by track record*, which a brand-new injected project does not have. This
satisfies the handoff's hard guardrail directly.

### 5.5 Rate & scope limits
- **Rate:** per-agent injection quota (e.g. N `createProject` + M `createTask` per
  rolling hour), enforced in the MCP adapter against a small counter keyed by
  `attribution.agent`. Over-quota → tool error, not a silent drop.
- **Scope:** an **allowlist of injectable target repos/paths** in `config.yaml`
  (e.g. `mcp.injectAllowedRoots: ["~/dev", "~/.factory-live/projects"]`). A
  `targetRepo` outside the allowlist is rejected. `new`-repo creation is capped and
  lands under the standard `~/.factory/projects/<slug>` root.
- **Spec size** is already bounded (`specMarkdown` max 200k in the Zod input).

## 6. Auth — local, token-based, no committed secrets

- **Transport is loopback-only.** The MCP server binds `127.0.0.1` (stdio for
  spawned clients; loopback HTTP/SSE for networked local agents). Unlike the PWA's
  `0.0.0.0` bind, a *work-writing* surface is never exposed to the LAN.
- **Bearer token, reused.** Callers authenticate with the daemon's existing
  `config.auth.token` (`~/.factory/config.yaml`, mode 600) — the same secret the
  PWA uses. The MCP adapter reads it from the environment
  (`FACTORY_TOKEN`) or the local config file at startup; **it is never written into
  any committed file, tool schema, or handoff.** Callers in the estate load it the
  same way they load other local secrets (env / `.env.local`, which are
  `.gitignore`d and deny-ruled).
- **Optional per-caller tokens (v2):** a `mcp.callers[]` map in config granting
  named agents distinct tokens + quotas, so attribution is cryptographic rather
  than self-declared. v1 self-declares `attribution.agent` and relies on the single
  shared token + loopback trust boundary; v2 hardens it. Documented as a follow-up,
  not a v1 blocker.

## 7. Freedom-loop integration sketch

Today `pipeline/run.md` Phase 2 emits a `handoffs/<slug>.md` paste-prompt and marks
it `emitted` in `handoffs/STATUS.md`; a human later runs
`factory task create --file …` (which doesn't yet exist). With this surface:

**Before (current):**
> When a `next_action` needs code changes in a factory-enabled repo → write
> `handoffs/<slug>.md`, mode `factory-task`, and wait for Ryan to run it.

**After (this surface exists):**
> When a `next_action` is a **mutating build in a factory-enabled repo**, the loop
> calls `factory.createProject` (new repo/spec) or `factory.createTask` (existing
> project) directly, passing the handoff's prompt as the `spec`/task body,
> `targetRepo` = the repo, `constraints` = the handoff's guardrails, and
> `attribution = {agent:"freedom-loop", ref:"<handoff slug>"}`. It records the
> returned `projectId` + `statusUrl` in `handoffs/STATUS.md` (state `injected`
> instead of `emitted`) and moves on. **The work is now on Factory's critical path,
> isolated and gated, at L1 — Ryan reviews and promotes it to `ready` from the PWA.**

**What changes in the handoff convention:**
- A handoff whose target is factory-enabled becomes a **direct injection**, not a
  paste-prompt. The `handoffs/<slug>.md` file becomes the *spec body* the loop
  submits (and an audit record), rather than a doc a human shells out.
- `handoffs/STATUS.md` gains an `injected → (operator promotes) → running → merged`
  lifecycle with the `projectId`/`statusUrl`, replacing the manual
  `emitted → running → pr-open` rows for factory targets.
- Non-factory targets (worktree/headless handoffs) are **unchanged** — the paste
  convention still governs repos Factory doesn't manage.
- The guardrail "mutating handoffs MUST isolate" is now *satisfied structurally*:
  injection routes through per-run worktrees + the verifier gate, so the loop stops
  hand-managing worktrees for factory repos.

Concretely, `pipeline/run.md` Phase 2 gains: *"If the target repo is
factory-enabled and reachable via the factory MCP, prefer `factory.createProject` /
`factory.createTask` over emitting a paste-prompt; record the `projectId` +
`statusUrl` in STATUS.md."*

## 8. Acceptance (of the follow-on build)

- MCP server exposes the five §4 tools; each resolves through the in-process tRPC
  caller against the **existing** procedures (no forked ingest).
- `factory.createProject` decomposes a freeform *and* a `plan-project-spec-v1`-shaped
  spec into a project + task DAG; returns `{projectId, tasks[], statusUrl}`.
- Injected projects verifiably land at **L1 + `autoAdvance:false`** and injected
  tasks at **`needs_triage`** (integration test asserts both).
- Attribution (`source: "mcp:<agent>"`, task `sourceInjection`) is persisted and
  queryable.
- No injected work can auto-start or auto-merge without an operator promotion
  (integration test: inject → assert no run fires under auto-advance).
- Thin CLI (`factory work create --spec-file … --repo …`) wraps the same calls.
- Auth via existing bearer token, loopback bind, no secret in any committed file.
- One ADR (025) records the decision; `AGENTS.md` gains a pointer.

## 9. Follow-on build task & sizing

**One mutating build task, ~1–1.5 weeks (personal ceremony).** Rough breakdown:

1. **Injected-path seam in ingest (~1–1.5 days):** add `injected` override to
   `confirmImportSpec`/`bootstrapProject` (force `collaborative` + `autoAdvance:false`)
   and land injected tasks at `needs_triage`; add `sourceInjection` to the
   `createTask` seam + `source: "mcp:*"` on the idea. Small, additive, well-tested
   seams.
2. **MCP server app (~2–3 days):** `apps/mcp` hosting the five tools over the
   in-process tRPC caller, stdio + loopback transport, quota + allowlist checks,
   attribution threading.
3. **Thin CLI (~0.5–1 day):** `factory work create|status|list` over the same client.
4. **Rate/scope config + tests (~1–1.5 days):** `mcp.*` config block, per-agent
   quota, injectable-roots allowlist, integration tests for the §8 assertions.
5. **Docs + ADR + freedom-loop wiring note (~0.5 day):** ADR-025, `AGENTS.md`
   pointer, and the `pipeline/run.md` convention change (done in the freedom repo,
   not here).

**Confidence:** high — no new engine, executor, or store; the work is a thin
authenticated adapter plus one small safety-override seam in the ingest. The risk
surface is the safety overrides (§5.1/§5.2), which are exactly what the integration
tests in §8 pin down.

## 10. Open questions (for sign-off)

1. **Host in-daemon vs sidecar?** In-daemon gives the in-process caller and one
   auth surface (recommended); sidecar isolates a crashy MCP transport. *Lean:
   in-daemon behind a config flag.*
2. **`needs_triage` vs `backlog` for injected tasks?** `needs_triage` = "not even
   vetted"; `backlog` = "vetted, not queued." Injection is unvetted-by-an-agent, so
   *lean `needs_triage`* — but a highly-trusted caller (Mabel) might warrant
   `backlog`. Per-caller policy in config?
3. **Per-caller tokens in v1 or v2?** (§6) Lean v2; v1 ships on the shared token +
   loopback boundary.
4. **A gated `factory.startRun` tool ever?** Only after the injected-work trust
   story is proven in practice; explicitly out of v1.
