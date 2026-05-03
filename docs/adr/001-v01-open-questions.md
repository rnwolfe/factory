# ADR-001 · v0.1 — disposition of spec §14 open questions

**Status:** accepted (2026-05-03)
**Scope:** carry-forwards into v0.2 planning

The spec's §14 open questions were acceptable to ship v0.1 with. This record states
how each one was resolved by the v0.1 build and what we are carrying into v0.2.

## 1. Tmux output capture rate

**Disposition:** accepted as-is for v0.1. `pipe-pane -o "cat >> <log>"` to a regular
file, tailed by `packages/runtime/src/tail.ts` at an 80 ms poll. Lines fan out to
both the structured event stream (parsed by the agent) and the `pane` WS channel
(raw bytes for xterm.js). Verified single-digit concurrent runs in integration
tests; not load-tested beyond that.

**Carry to v0.2:** if any single project's pane saturates the polling tail, switch
that path to a named pipe (`mkfifo`) so the daemon blocks on reads instead of
polling. The shape is otherwise unchanged.

## 2. Worktree disk usage

**Disposition:** addressed in `packages/runtime/src/runtime.ts`. After a run, if
the worktree is clean and produced no commits, it is removed via `git worktree
remove`. Dirty or productive worktrees are preserved for operator inspection.

**Carry to v0.2:** surface a per-project disk usage figure in the PWA settings
screen, and add a manual "prune worktrees" command. Auto-prune by age is post-v0.1.

## 3. Bearer token in WebSocket query string

**Disposition:** as designed. PWA cannot send `Authorization` headers on the WS
upgrade, so `?token=…` is used. `apps/daemon/src/auth.ts:extractToken` accepts both
header and query forms; the query form is constant-time-compared like the header.

**Carry to v0.2:** switch to subprotocol-based auth (`Sec-WebSocket-Protocol`) so
tokens never enter access-log URLs. Single-user single-LAN deployment for v0.1
makes the current shape acceptable.

## 4. Rubric YAML in a single column

**Disposition:** as designed. `rubric_versions.yaml TEXT NOT NULL`. Edits work via
`factoryd rubric import` (planned for v0.2; v0.1 reseeds from disk).

**Carry to v0.2:** if cross-rubric introspection becomes useful, add a parsed-axes
projection table populated on insert. No schema migration required for v0.1.

## 5. Idea capture from outside the PWA

**Disposition:** PWA is the only ingestion in v0.1. The `ideas.create` tRPC route
is reachable via curl with a bearer token, so a future Telegram bot or
email-to-inbox pipe can adopt the same surface without a schema change.

**Carry to v0.2:** prioritize a Telegram or email-to-inbox bridge if the inbox
empties because capture friction is too high. Watch for it in operator logs.

---

## v0.1 deltas the spec did not pre-specify

A few concrete decisions made in implementation that future-Ryan should know about:

- **`raw` stream event.** `packages/runtime/src/types.ts` adds `{ kind: "raw"; line }`
  emitted for every newline-terminated pane line. The daemon routes these to the
  `pane` WS channel only, never to `events` and never to the persisted `events` table.
  Without this, xterm.js had no source of bytes to render.

- **Per-run dedicated branch under `head` strategy.** Even when
  `BranchStrategy.type === "head"`, the runtime creates a worktree on
  `factory/run-<runId>`. The spec described "head" as commits landing on the
  current branch, but a single project running concurrently would otherwise
  collide on a single worktree path. Worktrees are still derived from HEAD as
  the base ref, so the practical effect matches the spec's intent.

- **Triage is invoked outside `runtime.spawn`.** `apps/daemon/src/triage/orchestrate.ts`
  pipes the prompt directly to `claude --print` (no worktree, no tmux, no commit
  tracking). `runtime.spawn` is for code-changing runs only. This kept triage
  fast (no worktree setup) and let the `agentInvoker` injection point in the
  triage orchestrator give us a clean test seam.

- **Per-pane sleep prelude.** The host sandbox prepends `sh -c 'sleep 0.15; …'`
  to every inner command. Without this, fast-exiting commands tear down the tmux
  session before `pipe-pane` can attach, dropping all output. The 0.15s window
  is the smallest that was reliable across the integration tests; revisit if it
  becomes a startup-latency problem.
