# ADR-015 · Registry discipline for harnesses and task backends

**Status:** accepted (2026-06-28)
**Scope:** extensibility hygiene for the two pluggable axes — agent/model families and
task backends. Triggered by an audit (two read-only passes) after the WS-D cross-model
work added a hardcoded family pair.

## Context

Factory has two registries that are *meant* to make adding a variant one-touch:
`AGENT_REGISTRY` (agent families + their models) and `taskStoreFor` (task backends).
The audit found the **dispatch seams are clean**, but **capability-specific logic
leaked out of the descriptor / interface into hardcoded branches** spread across the
codebase. Concretely, a third agent family needs ~15 edits across 11 files, and a third
task backend ~14 files — most of them `if (id === "codex")` / `if (taskBackend === …)`
branches that the registry was supposed to abolish.

## Decision

**The registry entry (agent descriptor) and the backend interface impl are the ONLY
places that should change to add a variant.** Everything else iterates or dispatches;
nothing branches on a literal id. Capabilities live *on* the descriptor/interface:

### Agents
- **One enum source.** `z.enum(AGENT_NAMES)` (exported as `AGENT_NAME_ENUM`), never a
  re-typed `z.enum(["claude-code","codex"])`. Same for TS unions (PWA imports `AgentName`).
- **Capabilities on the descriptor**, not in consumers: the cross-model *validator*
  (`validatorAgentId`), the log-envelope parser (use the agent's own `parseLine()`), auth
  guidance text, and the auth probe (`probeAuth`) — so `recover.ts`, `cross-model.ts`,
  `submit.ts`, `runner.ts`, `doctor.ts` iterate the registry instead of switching on id.
- **A shared `@factory/agent-config` package** so the CLI (`doctor`) can iterate the same
  descriptors the daemon uses, instead of a hardcoded codex auth check.

### Task backends
- **The `TaskStore` interface covers ALL backend ops**, not just CRUD: discussion/comments
  (`listComments`/`postComment`/`reactToComment`), `adopt`, and reply. The standalone
  `*Issue*` functions become thin `taskStoreFor(t).x()` dispatchers; **no caller branches
  on `taskBackend`.**
- **A backend registry** mirroring the agent registry: add-a-backend = one impl + one
  registration.
- **Backend-specific config lives in a blob**, not github-named columns on `projects`
  (`githubRemote`/`githubInstallationId` → a generic `backendConfig`).

## The test (the contract)

Adding a new agent family OR a new task backend must be: **(1) one new impl file, (2) one
registry entry/registration.** If a third edit is needed anywhere else, that site is a
discipline violation — fold the capability back into the descriptor/interface.

## Non-goals

Not changing behavior — this is structural. The agent + backend registries already exist
and work; this pulls the leaked capabilities back into them. Sequenced as verified slices
(suite green between), not one splat, because these are load-bearing core seams.
