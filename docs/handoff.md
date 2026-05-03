# Factory v0.1 — Claude Code Handoff

> **Purpose:** Drive the v0.1 build via Claude Code sessions. Use this document as the operator-facing playbook; the spec (`factory-v0.1-spec.md`) is the source of truth for design.

-----

## 1. Pre-Flight (operator does this once)

Before kicking off Claude Code:

1. **Provision the repo.** On the dedicated server (or your laptop, doesn't matter — the daemon eventually moves to the server):

   ```bash
   mkdir factory && cd factory
   git init
   ```

   Place `factory-v0.1-spec.md` at `docs/spec.md` and this file at `docs/handoff.md`. Initial commit.
2. **Decide the runtime location.** Confirm:
   - Bun installed (≥ 1.1)
   - Node not required, but if Bun doesn't cover it (e.g. some Drizzle Kit ops), keep Node 20 around as a fallback
   - tmux installed (≥ 3.0)
   - git ≥ 2.40
   - `claude` CLI installed and authenticated via subscription on the *server account* (the daemon will inherit these credentials)
3. **Set up Claude Code.** Run `claude` in the repo. If you've got skills installed, ensure `frontend-design` is among them — the PWA work will explicitly invoke it.
4. **Decide on session length.** v0.1 is about 4-6 milestones (below). Each milestone is one focused Claude Code session — anywhere from 1-4 hours of agent wall-clock. Don't try to do v0.1 in one shot; the context will degrade.

-----

## 2. Working Agreements

Conventions Claude Code must follow on every session.

- **Single source of truth: `docs/spec.md`.** When in doubt, re-read it. If anything in the spec is ambiguous or wrong, surface it as a decision card (in this case, a comment in PR or a note in `docs/adr/`) — don't silently improvise.
- **Branch per milestone.** `milestone/01-bootstrap`, `milestone/02-runtime`, etc. Merge to main only after the milestone's acceptance criteria pass.
- **Commit hygiene.** Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`). Small commits over big ones. The daemon will eventually run agents under the same hygiene; the meta repo sets the standard.
- **Tests where they pay off.** Unit tests for `@factory/runtime` (parsers, worktree logic, event emission). Integration test for the spawn happy path. Skip tests for thin tRPC route adapters and PWA components — visual review is faster.
- **No premature abstraction.** v0.1 has hard scope cuts. Don't generalize the agent provider interface for "future Codex" — generalize when Codex actually arrives in v0.2.
- **No external services.** No GitHub Actions, no Vercel, no anything. Everything runs locally or on the server.
- **Use the frontend-design skill.** When working on the PWA, *always* read `/mnt/skills/public/frontend-design/SKILL.md` before writing components. The PWA must look custom and considered.
- **Use the spec's repo layout.** Don't invent new directories. Don't rename `apps/daemon` to `daemon`. Consistency is cheap; bikeshedding is expensive.
- **Bun workspaces, not npm.** All package management via `bun install`. No mixing.
- **Format with Biome.** Pre-commit hook optional; `bun run format` in CI-like script.
- **ADRs for non-obvious choices.** If you make a call the spec didn't dictate, drop a short ADR in `docs/adr/NNN-title.md`.

-----

## 3. Milestone Plan

Six milestones. Each is independently verifiable. Do them in order; don't skip ahead.

### M1 — Repo bootstrap & shared scaffolding

**Outcome:** Empty workspace boots. `bun install` works. `bun run --filter '*' build` succeeds with empty stubs.

**Includes:**

- Bun workspaces config in root `package.json`.
- TypeScript base config (`tsconfig.base.json`); per-package `tsconfig.json` extending it.
- Biome config.
- `apps/daemon`, `apps/pwa`, `packages/runtime`, `packages/db`, `packages/shared` packages with empty index files and stub package.json.
- `.gitignore` covering Bun, node_modules, dist, .factory/runs, worktrees, data.db.
- `README.md` with a one-paragraph description and a "see docs/spec.md" link.
- `scripts/factoryd-init.ts` stub — does nothing yet.

**Acceptance:**

- `bun install` clean.
- `bun run --filter '*' typecheck` passes (empty stubs).
- Repo is committed; PR-style merge into main.

### M2 — `@factory/db` schema & migrations

**Outcome:** Database boots, schema matches spec §5.1, migrations work.

**Includes:**

- `packages/db/src/schema.ts` matching the spec.
- Drizzle Kit config; `bun run db:generate` produces a migration.
- `bun run db:migrate` applies migrations against `~/.factory/data.db` (path configurable via env).
- A small `seed.ts` that imports the v0.1 rubric YAML and the triage prompt template into `rubric_versions` and `prompts`.

**Acceptance:**

- Migrations apply cleanly to a fresh DB.
- `seed.ts` populates exactly one active rubric and one active prompt.
- Drizzle's typed query helpers compile and run.

### M3 — `@factory/runtime` host-mode spawn

**Outcome:** From a script, `runtime.spawn()` runs Claude Code in a tmux session against a worktree and emits structured events.

**Includes:**

- All interfaces from spec §7.1.
- Host sandbox impl in `packages/runtime/src/sandboxes/host.ts`.
- Claude Code agent in `packages/runtime/src/agents/claude-code.ts` — argv builder, JSONL stream parser.
- Worktree manager: create, reuse, cleanup.
- Tmux integration: session naming, `pipe-pane`, output reader.
- Staleness detector hook (regex-based on known prompt patterns; lives in the agent provider).
- A small CLI harness in `packages/runtime/src/bin/dev-spawn.ts` that takes a project path and a prompt and runs spawn end-to-end. This is the dev loop for the rest of M3.

**Acceptance:**

- Running `bun packages/runtime/src/bin/dev-spawn.ts <projectPath> "say hello"` produces a tmux session, runs Claude, captures stream events, returns a `RunResult` with at least the agent's text output captured.
- Concurrent spawns to two different projects don't interfere.
- `AbortSignal` interruption kills the agent and tears down the tmux session within 5 seconds.
- Unit tests for the agent's JSONL parser cover the stream-json shape.

### M4 — Daemon: tRPC + WebSocket + workers

**Outcome:** `factoryd` boots, serves tRPC and WebSocket, schedules and runs `Run`s end-to-end.

**Includes:**

- `apps/daemon/src/index.ts` with full lifecycle: load config, init DB, start HTTP, start WS, start workers, register signal handlers.
- All routers from spec §6.1 (stubbed where needed for v0.1).
- WebSocket hub for the three channels in spec §6.2.
- Worker pool (max 4) that picks up `runs` rows in `status: queued` and executes via `@factory/runtime`.
- Bearer token auth middleware.
- Triage orchestration: `ideas.create` enqueues a triage call, runs it via `@factory/runtime` against the active rubric+prompt, parses the JSON response, writes a `decisions` row.
- Project bootstrap on `decisions.action({ action: "approve" })`.

**Acceptance:**

- Submit an idea via tRPC (curl or a tiny test client) → triage decision appears within ~2 minutes.
- Approve the decision → project directory exists at `~/factory/projects/<slug>/`, with `.factory/` populated and an initial commit.
- Start a run → tmux session live; events stream over WS.
- `SIGTERM` to the daemon → graceful shutdown; in-flight runs aborted; DB intact.

### M5 — PWA shell & decisions inbox

**Outcome:** The PWA loads on a phone, the operator can paste their token, see the decisions inbox, submit ideas, and action decisions.

**Includes:**

- Vite + React + Tailwind v4 + shadcn (initialized via shadcn CLI; components owned in `apps/pwa/src/components/ui/`).
- tRPC client wired with TanStack Query.
- Routes from spec §8.1 — at least `/`, `/inbox/new`, `/projects`, `/settings`. `/projects/:id` and live pane come in M6.
- The decisions inbox card per spec §8.2 — including swipe gestures, long-press menu, dense layout.
- Theming per spec §8.4 — dark default, custom feel.
- Auth gate that prompts for the bearer token on first load.

**Acceptance:**

- On a phone, the operator can: enter a token, submit an idea, see it triaged, action a decision (approve/park/trash/decompose), and see the resulting state change reflected.
- Mobile-first layout passes the eye test — dense, considered, not "shadcn default."
- The frontend-design skill was consulted (verifiable in PR description).

### M6 — Project detail, live pane, tagging

**Outcome:** End-to-end demo per spec §15 works on a phone.

**Includes:**

- `/projects/:id` — task list, run list, tag chip, "Start Run" action.
- `/projects/:id/runs/:runId` — xterm.js live pane bound to `/ws/pane`, structured event ticker bound to `/ws/events`.
- Tagging mutation with optimistic updates and a one-tap UI in the project header.
- Mobile keyboard handling for the live pane.

**Acceptance:**

- The full demo path in spec §15 runs without intervention.
- `bun run --filter '*' typecheck && bun run --filter '*' test` both pass.
- v0.1 tagged in git; spec section 14 questions revisited and either resolved or carried forward to v0.2.

-----

## 4. The Kickoff Prompt for Claude Code

Paste this at the start of M1's session. Adapt the milestone reference for subsequent sessions.

```
You are working on Factory v0.1, a single-user software factory.

The complete specification is at docs/spec.md. The handoff playbook
including milestone plan and working agreements is at docs/handoff.md.
Read both end-to-end before writing any code.

Today's session: Milestone M1 — Repo bootstrap and shared scaffolding.

Acceptance criteria for M1 are in docs/handoff.md §3 under "M1". Do not
proceed beyond M1 in this session.

Working agreements (docs/handoff.md §2) are non-negotiable. In particular:
- Use the repo layout from spec §12 verbatim.
- Bun workspaces, not npm.
- Conventional commits, small.
- ADRs in docs/adr/NNN-title.md for non-obvious choices.

When you finish M1, summarize what you built, paste the file tree, and
list anything ambiguous or worth flagging for the operator. Do not start
M2 — that's a separate session.

Begin by reading the spec.
```

For each subsequent milestone, the prompt is the same with the milestone reference updated and the prior milestones noted:

```
Today's session: Milestone M3 — @factory/runtime host-mode spawn.

Milestones M1 and M2 are complete and merged to main. The current state
of the repo reflects them. Read docs/spec.md and docs/handoff.md fresh
before writing code; then implement M3 per its acceptance criteria.
```

-----

## 5. Per-Session Operating Loop

How to run a milestone session well.

1. **Start fresh context.** New Claude Code session per milestone. Don't try to carry context across — the spec + handoff + repo state is enough.
2. **Read first, code second.** The agent reads spec + handoff + relevant existing code before touching anything.
3. **Plan before doing.** For non-trivial milestones (M3, M4, M5, M6), the agent should produce a short plan and pause for operator review before implementing. Quick `--print` mode is fine; aim for ~150-300 word plans.
4. **Test along the way.** Don't save tests for the end. M3 unit tests should land alongside the parser they test.
5. **Surface decisions.** When the agent hits something the spec didn't cover, it stops, writes an ADR draft, and asks. Don't let it improvise major design.
6. **Demo at the end.** Each milestone ends with a runnable demonstration of its acceptance criteria, however small. M2 demos as "migrations apply, seed runs." M5 demos as "PWA on phone, action a decision."

-----

## 6. Failure Modes & Recovery

What can go wrong, and how the operator handles it.

| Failure                                                              | Likely cause                                                | Recovery                                                                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code session goes off-rails (writes huge files, ignores spec) | Context degraded; agent hallucinated requirements           | Abort, restart session, sharper prompt                                                                                                                 |
| Migration fails                                                      | Drizzle Kit version drift; missing migration file           | `rm -rf data.db` (it's v0.1, no production data); regenerate                                                                                           |
| Tmux session leaks                                                   | Daemon crashed mid-run                                      | `tmux kill-server` is fine on a v0.1 server; daemon doesn't expect tmux state to survive its own restart                                               |
| Claude staleness during a run                                        | First-time hit on the spec §7.3 path                        | The spec describes the design but M3 may not implement detection robustly. Acceptable to land M3 with worktree-as-truth only and add detection in v0.2 |
| PWA looks generic                                                    | Frontend-design skill not invoked, or invoked superficially | Dedicated polish session after M5/M6; the spec mandates this is a first-class concern                                                                  |

-----

## 7. Definition of Done for v0.1

All six milestones merged. The §15 demo recorded. Spec §14 open questions revisited. Tag `v0.1.0`. Move to v0.2 planning.

-----

## 8. Notes for Future-You

- This document and the spec are themselves a v0 of the factory's "spec foundry" stage. As you live with v0.1, expect both to need revisions before v0.2 work starts.
- The decisions inbox is the only attention sink. If you find yourself checking other surfaces, ask why; the answer is either a missing inbox capability or a discipline lapse.
- Resist building anything in the post-v0.1 backlog until v0.1 ships. The whole point is the spine first.
