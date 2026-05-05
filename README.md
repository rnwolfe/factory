# Factory

A single-operator software studio: **ideas in, projects out, agents under loose human supervision.** A Bun daemon plus a mobile-first PWA, run on a server you own, that turns a stream of ideas into a portfolio of running codebases.

The operator's only must-respond surface is the decisions inbox. Everything else is read-only or one-tap.

## Vision

Factory exists because most "AI coding" tools optimize for a single chat in a single repo. Real software work is plural — many projects, many threads, many running tasks. The bet:

- **One operator, many projects, in flight.** A worker pool runs up to N agent sessions concurrently across all projects.
- **Path A — net-new ideas.** Capture from anywhere → triage → decision → bootstrap → tasks. Friction is on the agent's side, not the operator's.
- **Path B — continuous execution.** Once a project exists, agents work on its tasks against the project's vision and conventions, not in a vacuum. CLAUDE.md is the doctrine; audits keep the project honest; plans freeze before runs start.
- **Phone-first.** Capture an idea on your phone in 10 seconds. Approve a decision from the train. Watch a run on the bus. Every screen works at 390px.
- **Honest completion.** Every code-changing run ends with a structured `factory-status` declaration; null parse means the run failed, not "succeeded with no diff."

For the longer arc see [`docs/spec.md`](./docs/spec.md) (v0.1 frozen), the v0.2/v0.3/v0.4 deltas in `docs/spec-v0.*.md`, and [`docs/vision.md`](./docs/vision.md) (living document of what we learned by running it). [`CLAUDE.md`](./CLAUDE.md) is the on-arrival orientation for any agent (or human) about to touch the code.

## How to run

### Quick start (live daemon)

Factory is meant to run as a long-lived service on a host you own. The CLI handles the lifecycle.

```sh
# clone & build
git clone https://github.com/rnwolfe/factory.git ~/factory-live
cd ~/factory-live
bun install
bun run cli:install            # builds the binary, symlinks ~/.local/bin/factory

# install as a systemd user unit and start it
factory install                # writes ~/.config/systemd/user/factory.service
                               # asks about enable-linger (recommended — survives logout)
factory status                 # confirm: unit active + /health responding
```

PWA is at `http://<host>:<port>/`; bearer token in `~/.factory/config.yaml` (mode 600). On first boot the daemon synthesizes an ephemeral token and prints it — copy it into your phone's PWA for auth.

`factory --help` lists every CLI subcommand. The most-used:

```sh
factory up | down | restart   # service control
factory status                # systemctl status + /health probe
factory logs -f               # journalctl -f for the unit
factory upgrade               # fetch + restart on the configured channel
factory channel <stable|nightly|dev>
factory doctor                # preflight checks (bun, git, unit, /health, db, etc.)
```

### Configuration

`~/.factory/config.yaml` (mode 600). Bootstrap-only fields live here: `auth.token`, `port`, `host`, `workdir`, `dbPath`. Everything operator-tunable (git author, run concurrency, GitHub token, factoryProjectId, upgrade channel) is editable from the PWA's `/settings` and persists in the SQLite DB — yaml seeds defaults on first boot, the DB takes precedence afterwards.

Environment variable overrides (`FACTORY_PORT`, `FACTORY_HOME`, `FACTORY_TOKEN`, …) work for any field; useful for ephemeral / containerized runs.

### Upgrading

```sh
factory channel resolve     # dry-run: see what the channel currently maps to
factory upgrade --dry-run   # preview: HEAD → target sha + commit count
factory upgrade             # actually do it: fetch → checkout → bun install (if lock changed)
                            #                 → migrate → restart → /health probe
```

Channels:
- `stable` — most recent `v*.*.*` tag on `origin` (skips pre-releases).
- `nightly` — tip of `origin/main`.
- `dev` — tip of a configured branch (default `dev`; override with `factory channel dev --dev-branch=<name>`).

Migrations are forward-only. `factory upgrade` refuses dirty checkouts without `--force`. On post-checkout failure the operator gets an explicit `git checkout <prior> && factory restart` rollback recipe; auto-rollback is backlog.

## How to develop

### Layout

Bun workspaces:

```
apps/
  daemon/     # Bun + tRPC + WebSocket + worker pool
  pwa/        # static SPA, served by the daemon
  cli/        # `factory` operator CLI (Bun --compile binary)
packages/
  db/         # drizzle schema + migrations + seed
  runtime/    # tmux + git worktree + agent providers
  shared/     # cross-app types
```

Single daemon process. SQLite at `~/.factory/data.db`. Project workdirs at `~/.factory/projects/<slug>`. Per-run worktrees at `~/.factory/worktrees/<slug>/<runId>` (off the project root so `git status` stays clean).

### Dev loop

```sh
bun install
bun run dev          # daemon (--watch) + PWA in parallel
bun run typecheck    # all workspaces
bun run check        # biome (lint + format)
bun test             # bun test, all workspaces
bun run db:generate  # drizzle-kit generate (after schema edits)
bun run db:migrate   # apply migrations
bun run seed         # idempotent prompt + rubric seed
```

Per-package: `bun --filter '@factory/<name>' <script>`.

### Conventions (load-bearing — see CLAUDE.md for the full list)

- **No npm.** Bun for everything (install, scripts, test runner).
- **Biome over ESLint/Prettier.** `bun run check` before committing.
- **Conventional commits, small.** Branch per concern; PR-style merges (`--no-ff`) once a thread is coherent.
- **ADRs for non-obvious calls.** `docs/adr/NNN-title.md`.
- **Migrations are checked in.** Generate via Drizzle Kit; never hand-edit.
- **Frontend aesthetic is load-bearing.** Warm-dark `#0a0908`, amber accent, Fraunces / Geist / Geist Mono, dense rows, chips not pills, no shadcn defaults. Mobile-first; every screen must work at 390px.

### Architectural contracts (don't break casually)

A handful of contracts hold the system together. The full list is in [`CLAUDE.md`](./CLAUDE.md) — the highlights:

- **`factory-status` footer.** Every code-changing run requires the agent to emit a fenced JSON block with `done | blocked | failed`. Null parse → `failed`, never silently `completed`.
- **Auto-commit before listing commits.** Worktrees go through `commitAllChanges` before the runtime computes the run's commit list. Without this, agents that wrote files but didn't commit produced empty `factory/run-*` branches.
- **Per-run dedicated branch.** Every run gets `factory/run-<runId>` even under `head` strategy — concurrent runs on one project would otherwise collide.
- **Successful runs auto-merge to main.** `--no-ff` merge after `status="completed"`. Conflicts abort the merge, fail the run summary, and **hold auto-advance** so the next task doesn't start from a main that doesn't include this run's work.
- **Plans are first-class.** Triage approve creates a `project_spec` plan in the inbox; the project materializes when that plan freezes. Same shape for `task_plan`, `feature_plan`, `project_vision`.
- **Audits are read-mostly.** Audits produce reports → reports promote to plans or bugs → plans freeze and drive runs. Audits never auto-merge code.

### Releasing

When a coherent commit-batch lands on `main`, run the release skill: [`skills/release/SKILL.md`](./skills/release/SKILL.md). It bumps the version, generates the changelog, cuts an annotated tag, and prints `git push` instructions. **It does not push** — that's an operator-authorized action.

CLAUDE.md's "When to suggest a release" section tells the agent when to flag a release-worthy moment so it doesn't get forgotten.

## Dev / live tracks (the self-reinforcing loop)

Factory is meant to be dogfooded — run a live Factory daemon, adopt the Factory repo as a Factory project, capture feedback inside Factory while you're using it, iterate on Factory with Factory.

The catch: a daemon running `bun --watch` from the same checkout it edits will hot-reload mid-run when an agent writes a file. The fix is two checkouts:

```
~/factory-live    # the running service. Stable/nightly/dev channel via factory upgrade.
~/dev/factory     # your dev workspace. Adopted into factory-live as a Factory project.
```

### Setup (after the live daemon is already running per "Quick start")

```sh
# 1. dev checkout
git clone https://github.com/rnwolfe/factory.git ~/dev/factory
cd ~/dev/factory
bun install

# 2. point the live daemon at your dev checkout as a project
#    (in the PWA: /projects/import → "adopt local path" → ~/dev/factory)
#    or use the importFromPath tRPC mutation directly.

# 3. tell the live daemon which project IS itself, so feedback can promote
#    to plans/tasks on the right project. Set `factoryProjectId` in /settings
#    to the just-imported project's id.
```

Now the loop closes:

1. **You work in `~/dev/factory`** — runs/sessions create worktrees under `~/.factory/worktrees/factory/...`, modify the dev checkout in those worktrees, and merge into `~/dev/factory`'s `main`. The live daemon is reading from `~/factory-live`, not `~/dev/factory`, so its source files don't change during a run.
2. **You use Factory** — capture ideas on your phone, approve decisions, watch runs, browse the code. When something rubs the wrong way, hit the feedback affordance (thumb-up / thumb-down + body) on the screen where you noticed it.
3. **Feedback iterates with the agent** — feedback rows live in the live daemon's DB, get an agent reply via `feedback-iterate-v1`, can be promoted to a `feature_plan` (substantive work) or `task` (single change) **on the Factory project** (because `factoryProjectId` points at it).
4. **The dev checkout produces commits + tags** — when a coherent batch lands on `main`, run the release skill. Push the tag.
5. **The live daemon picks it up** — `factory upgrade` (manual, deliberate) on `~/factory-live` resolves the new `v*.*.*` tag, restarts, probes `/health`. Now you're using the version of Factory that contains your own feedback.
6. **Repeat.**

The two checkouts decouple "the daemon I'm using" from "the codebase I'm changing." A run that breaks Factory only breaks the dev checkout — the live one stays on the last known-good tag until you choose to upgrade. Feedback survives across upgrades because the DB at `~/.factory/data.db` is independent of the checkout.

If you'd rather run dev-channel for tighter feedback latency (every push to `dev` is the next upgrade target), set `factory channel dev` on the live install. Stable is the right default for a host you depend on; dev is the right default for the host you're using to dogfood.

## Reading order for new agents and humans

1. [`CLAUDE.md`](./CLAUDE.md) — the on-arrival orientation. Conventions, contracts, where things live.
2. [`docs/spec.md`](./docs/spec.md) — v0.1, frozen. The spine.
3. [`docs/vision.md`](./docs/vision.md) — what living with each release taught us.
4. [`docs/spec-v0.2.md`](./docs/spec-v0.2.md), [`docs/spec-v0.3.md`](./docs/spec-v0.3.md), [`docs/spec-v0.4.md`](./docs/spec-v0.4.md) — implementation-ready deltas.
5. [`docs/adr/`](./docs/adr/) — non-obvious decisions, with rationale.

For the operator lifecycle (CLI, install, upgrade) specifically: [`docs/side-cuts-3.md`](./docs/side-cuts-3.md).
