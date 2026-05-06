# Side cuts 3 — operator lifecycle: service, CLI, channels, releases

> One focused batch: turn Factory into a real long-running service the
> operator can install, observe, and upgrade from a CLI, and add a release
> ritual so the upgrade channel actually has fresh material.
>
> Motivating use case: dogfood Factory on Factory itself. Today, the
> dev daemon runs `bun --watch` from the same checkout it edits; any
> code-changing run reloads it mid-flight. The endgame is a
> *stable-checkout* live daemon (installed as a systemd user service,
> upgraded via `factory upgrade`) and a *dev checkout* the operator
> adopts as a Factory project. This batch is the lifecycle plumbing
> that has to land **before** that split — without it, the two-checkout
> story is "just `cd ~/factory-live && git pull && pkill bun && bun
> run start &`," which is fine for one operator on one host but won't
> survive any drift.
>
> Decisions already made:
> - Stable checkout's `origin` is the upstream Factory repo (GitHub).
>   `factory upgrade` is a `git fetch` + ref resolution against `origin`.
> - Migrations are forward-only. No rollback in this batch — `factory
>   rollback` is backlog.
> - systemd user unit only. macOS `launchd` is backlog.
> - Channels: `stable` (most recent `v*` tag), `nightly` (origin/main
>   tip), `dev` (configurable branch — defaults to `dev`, overridden in
>   config.yaml).
>
> Cuts are independently shippable; later cuts depend on earlier ones
> as noted. Suggested order is smallest first.

-----

## Execution semantics

- Each cut is one commit-batch. Don't bundle.
- Hard guardrails (overnight-run skill rules) still apply: no force
  push, no destructive ops on shared state, no remote operations
  except where the cut's own design requires them (cut 6 invokes
  `git push --tags` only when the operator explicitly runs the
  release skill).
- The CLI is a *new* surface (`apps/cli/`); the daemon stays
  unchanged for cuts 1–2 and gets a small additive change in cut 3
  (`/health` + `sd_notify`).

Suggested order — small to large:

1. **CLI scaffold + thin wrappers** — `up`/`down`/`restart`/`status`/`logs` over `systemctl --user`. No daemon changes.
2. **`factory install` / `uninstall`** — write the systemd user unit, `enable-linger`, `daemon-reload`, `enable --now`.
3. **Daemon health endpoint + `sd_notify`** — `Type=notify` becomes feasible; `factory status` reports daemon `/health`.
4. **Channels + config** — `factory channel <name>`, channel resolver, `factory.upgrade.*` config block.
5. **`factory upgrade`** — fetch, resolve, install, migrate, restart, probe.
6. **Release skill + CLAUDE.md guidance** — `skills/release/SKILL.md` with version bump + changelog + tag steps; CLAUDE.md gains a "when to suggest a release" section.
7. **`factory doctor`** — preflight that catches the broken-install cases the prior cuts can produce.

Estimated nominal effort: ~6 human-days.

-----

## 1. CLI scaffold + thin systemctl wrappers

### Goal

A `factory` binary that the operator can run from anywhere. First
version is just a structured wrapper over `systemctl --user` so the
muscle memory shifts off raw `systemctl` immediately, even before
install/upgrade ship.

### What ships

- New workspace `apps/cli/` with `package.json`, `tsconfig.json`,
  `src/index.ts` (entry).
- Bun-built single-file binary at `apps/cli/dist/factory` (via `bun
  build --compile`), plus a top-level `bun run cli:install` script
  that symlinks it into `~/.local/bin/factory`.
- Subcommands (cut 1 only): `up`, `down`, `restart`, `status`,
  `logs [-f] [--since=…]`. All call `systemctl --user … factory`
  (or `journalctl --user -u factory …` for `logs`).
- Useful exit codes: 0 = ok, 1 = systemctl reported error, 2 = unit
  not installed (cut 2 hasn't run, or operator skipped install).
- Help text is mandatory (`factory --help`, `factory <cmd> --help`).
  No third-party CLI framework — Bun + a hand-rolled argv parser is
  enough for ~10 subcommands total across the batch.

### Implementation

- `apps/cli/src/index.ts` dispatches on `argv[2]` to handlers in
  `src/commands/{up,down,restart,status,logs}.ts`.
- `src/lib/systemctl.ts` runs `systemctl --user <verb> factory` via
  `Bun.spawn`, surfaces stderr verbatim. Detects "Unit factory.service
  could not be found" → exit 2 with a one-line "run `factory install`".
- `src/lib/journal.ts` similarly for `journalctl --user -u factory`.
  Default `logs` shows last 100 lines + exits; `logs -f` execs into
  journalctl so Ctrl-C semantics are native.
- No daemon changes.

### Done criteria

- `factory up`, `down`, `restart`, `status`, `logs`, `logs -f`
  all work against a manually-created systemd user unit (test rig).
- `factory` (no args) prints help and exits 0.
- `factory <unknown>` exits 1 with help.
- `apps/cli/test/cli.integration.test.ts` covers each subcommand
  with a stubbed `systemctl` (PATH override to a fake script that
  records argv and returns canned output).

### Notes

- The compiled binary is fine to commit-ignore; the `cli:install`
  script builds on demand. Don't ship a prebuilt binary in-repo.
- The CLI must work when the daemon is down (so the operator can use
  it to *bring the daemon up* — chicken-and-egg).

-----

## 2. `factory install` / `uninstall`

### Goal

One command turns a fresh checkout into a running service. Reverses
cleanly.

### What ships

- `factory install [--checkout=<path>] [--home=<path>] [--port=<n>]
  [--force]` writes:
  - `~/.config/systemd/user/factory.service`
  - Runs `systemctl --user daemon-reload`
  - Runs `loginctl enable-linger $USER` (so the unit survives logout)
    — gated behind a y/N prompt unless `--yes`
  - Runs `systemctl --user enable --now factory`
- `factory uninstall` reverses: `disable --now factory`, removes the
  unit, runs `daemon-reload`. Does *not* touch `~/.factory/` (data is
  the operator's; deletion is explicit).
- `--force` overwrites an existing unit. Default refuses with a clear
  message if `~/.config/systemd/user/factory.service` already exists.

### Implementation

- `apps/cli/src/commands/install.ts` builds the unit content from a
  template literal:

  ```
  [Unit]
  Description=Factory daemon
  After=network-online.target

  [Service]
  Type=simple                         # cut 3 flips this to notify
  WorkingDirectory={checkout}
  Environment=FACTORY_HOME={home}
  ExecStart=/usr/bin/env bun run --cwd {checkout} start
  Restart=on-failure
  RestartSec=2

  [Install]
  WantedBy=default.target
  ```

- Defaults:
  - `--checkout` → `git rev-parse --show-toplevel` of the cwd.
  - `--home` → `~/.factory`.
  - `--port` is informational only (daemon already reads from config).
- Validates `bun` is on PATH and `{checkout}` is a Factory git repo
  before writing the unit.

### Done criteria

- Fresh box + fresh clone + `bun install` + `factory install` →
  daemon comes up, `factory status` shows active, PWA reachable on
  `localhost:<port>`.
- `factory uninstall` → unit gone, `~/.factory/` untouched.
- `apps/cli/test/install.integration.test.ts` runs against a
  temp `XDG_CONFIG_HOME` and stubbed `systemctl`/`loginctl`; verifies
  unit content is byte-correct and idempotent under `--force`.

### Notes

- `enable-linger` is a *user-systemd* concept; on hosts without
  systemd-logind (NixOS minimal, alpine), the install should detect
  and degrade gracefully (skip linger, warn).

-----

## 3. Daemon health endpoint + `sd_notify`

### Goal

Make the unit `Type=notify` so systemd has a real readiness signal,
and give the CLI a structured target for `status`/post-upgrade probe.

### What ships

- New endpoint: `GET /health` returns `{status: "ok", version,
  uptime_ms, db_open: true, active_runs: n, active_sessions: n}`.
  No auth required (localhost-only daemon already; if remote bind
  becomes a thing later, gate it).
- After all init (db open, migrations done, ws listening), daemon
  calls `sd_notify("READY=1\n")` via Bun's `dgram` to
  `$NOTIFY_SOCKET`. No-op when env var is absent (e.g. dev).
- `factory status` (cut 1) gains a second line: probes
  `http://localhost:<port>/health` and renders `version`, `uptime`,
  `active runs/sessions`. Falls back to the systemctl line if
  `/health` fails.
- Unit template (cut 2) flips `Type=simple` → `Type=notify`,
  adds `NotifyAccess=main`.

### Implementation

- `apps/daemon/src/health.ts` exports the response builder; wired
  into the existing HTTP handler as a path branch *before* tRPC.
- `apps/daemon/src/sd-notify.ts` — small UDP datagram helper. Keep
  it dependency-free.
- `apps/cli/src/commands/status.ts` adds the `/health` probe with a
  500 ms timeout.

### Done criteria

- `journalctl --user -u factory` on startup shows
  `Started Factory daemon.` *only* after `READY=1` — i.e. systemd
  considers the unit started after the daemon is actually serving.
- `factory status` shows version + uptime + active runs/sessions
  when daemon is up; degrades to "unit active but /health
  unreachable" when daemon is wedged.
- `apps/daemon/test/health.integration.test.ts` covers the response
  shape under no-runs / one-run / db-error states.

-----

## 4. Channels + config

### Goal

Wire the upgrade channel into config so cut 5 can resolve it. No
behavior change yet.

### What ships

- New config block in `~/.factory/config.yaml`:

  ```yaml
  upgrade:
    channel: stable    # stable | nightly | dev
    devBranch: dev     # only consulted when channel == dev
    remote: origin     # almost always 'origin'
  ```

- Defaults applied if section absent (same shape as existing config
  fields).
- `factory channel` (no args) → prints current channel, last-resolved
  sha (if `~/.factory/state/last-good.sha` exists).
- `factory channel <stable|nightly|dev>` → writes the YAML in place
  (preserves comments via the existing yaml lib's round-trip mode).
- `factory channel resolve` → fetches, resolves channel → sha,
  prints `<channel> -> <sha> (<short subject>)`. No install, no
  restart. This is the dry-run cut 5 will lean on.

### Implementation

- `apps/cli/src/lib/config.ts` reads/writes `~/.factory/config.yaml`.
  Use the same yaml lib the daemon uses for round-trip stability.
- `apps/cli/src/lib/channel.ts`:
  - `stable` → `git ls-remote --tags --refs <remote>` → highest
    `v*.*.*` semver-sorted.
  - `nightly` → `git rev-parse <remote>/main` after `git fetch
    <remote> main`.
  - `dev` → same but with `<remote>/<devBranch>`.
- All git operations run via `Bun.spawn(["git", …], {cwd:
  <stable-checkout>})`. Stable checkout location lives in config
  (cut 2's `--checkout` is the canonical one).

### Done criteria

- `factory channel` round-trips without losing comments in
  config.yaml.
- `factory channel resolve` prints a sha + subject for each of the
  three channels (test rig with a fixture remote).
- `apps/cli/test/channel.integration.test.ts` covers the three
  resolvers + the "no tags yet" stable fallback (returns empty +
  exit 1 with a clear message).

-----

## 5. `factory upgrade`

### Goal

The big one. Fetch, resolve, install deps, migrate, restart, probe
— in one command, with the operator able to interrupt safely at
any stage.

### What ships

- `factory upgrade [--channel <name>] [--dry-run] [--force]`:
  1. Refuse if `<checkout>` is dirty (uncommitted changes / unstaged
     edits / untracked files matching `.gitignore`-misses). `--force`
     overrides; useful for the dev checkout case.
  2. `git fetch --tags <remote>`.
  3. Resolve channel → target sha (cut 4).
  4. If target sha == HEAD sha, print "already on <sha>" and exit 0.
  5. `--dry-run`: print "would upgrade <HEAD> → <target> (<n>
     commits, <m> migrations new)" and exit.
  6. `git checkout <target>` (detached HEAD is fine and intended —
     channels are sha pointers, not branches the operator edits).
  7. `bun install --frozen-lockfile` if `bun.lockb` differs from the
     prior HEAD.
  8. `bun run db:migrate` (idempotent today).
  9. `systemctl --user restart factory`.
  10. Poll `/health` for up to 15s; require version reflects the new
      sha (daemon reads version from a build-time constant or
      `git rev-parse HEAD` fallback).
  11. On success: write `<target>` to `~/.factory/state/last-good.sha`,
      append a row to `~/.factory/state/upgrade-log.jsonl`
      (`{ts, from, to, channel, ok}`).
  12. On failure: leave the operator on the new sha, print a clear
      "rollback with: git checkout <prior-sha> && factory restart" —
      explicit, not magic. (Rollback automation is backlog.)

### Implementation

- `apps/cli/src/commands/upgrade.ts` orchestrates the steps as a
  small state machine. Each step is its own function in
  `src/upgrade/{precheck,fetch,checkout,deps,migrate,restart,probe}.ts`.
- The probe re-uses the cut 3 `/health` endpoint and additionally
  requires `version === <target sha 7-prefix>`.
- Verbose by default; `--quiet` suppresses non-error stages.

### Done criteria

- `factory upgrade --dry-run` prints the expected target without
  side effects on a clean checkout.
- A real upgrade against a fixture remote with a fresh tag flips
  HEAD, runs migrations, restarts the unit, and `/health` reports
  the new version within 15s.
- `apps/cli/test/upgrade.integration.test.ts` covers: clean upgrade,
  dirty refuse, dirty + `--force`, target == HEAD no-op, migration
  step failure (leaves checkout on new sha, exits non-zero, writes
  upgrade-log entry with `ok: false`).

### Notes

- v1 is single-checkout: the upgrade target is the same checkout
  the operator installed. The dev/live two-checkout split (the
  motivating use case) is a *deployment* on top of this — install
  the live daemon from `~/factory-live`, leave dev work in
  `~/dev/factory`. No code changes needed for that split once the
  CLI exists.

-----

## 6. Release skill + CLAUDE.md guidance

### Goal

Channels are useless without published material. This cut closes the
loop: a release skill the operator (or an agent helping them) can
run on the dev checkout to cut a tag, plus CLAUDE.md guidance that
*proactively suggests* releases at the right moments so it doesn't
get forgotten.

### What ships

- `skills/release/SKILL.md` (new top-level `skills/` dir, mirrors the
  audit-skill-templates pattern). Steps:
  1. Verify on `main` and clean.
  2. List commits since the last `v*` tag (`git log
     <last-tag>..HEAD --oneline`).
  3. Group conventional-commit subjects into Added / Changed / Fixed
     sections.
  4. Bump the appropriate semver component (manual judgment based on
     the diff — surface the call to the operator).
  5. Write `CHANGELOG.md` entry under `## v<version> — <date>`.
  6. Update `package.json` version (root + workspaces — confirm
     whether workspaces should pin together; default yes).
  7. Commit `chore(release): v<version>`.
  8. Tag `v<version>` with the changelog entry as the annotation
     body.
  9. Print operator instructions: `git push origin main && git push
     origin v<version>`.
- `CHANGELOG.md` at repo root with the v0.1.0 baseline backfilled
  from the existing tag history.
- CLAUDE.md gains a new section, **"When to suggest a release"**,
  near the existing "Architectural contracts" block:

  ```
  ## When to suggest a release

  After any commit-batch that is a coherent unit of operator-visible
  change, suggest invoking the release skill (`skills/release/`).
  Concretely: any merged feature batch (a "side cut" or larger), any
  meaningful bugfix that operators on stable channel would benefit
  from, and any breaking schema or contract change.

  Don't suggest releases for: docs-only PRs, refactors with no
  observable diff, internal tooling changes that don't reach the
  operator. When in doubt, name the operator-visible delta and let
  the operator decide.

  The release skill handles version bump, changelog generation, tag,
  and push instructions. Do not push tags yourself — surface the
  command to the operator.
  ```

### Implementation

- `skills/release/SKILL.md` is a normal markdown file. Its contents
  are the playbook the agent (or operator) follows; no executable
  glue lives in `skills/`.
- CLAUDE.md edit is a single section append.

### Done criteria

- A practice run against the current HEAD produces a coherent
  v0.2.0 changelog, version-bumps, and a signed annotated tag (no
  push).
- CLAUDE.md change passes the "would a fresh agent know to suggest
  a release after merging cut 5" test on a manual reread.

-----

## 7. `factory doctor`

### Goal

Catch the install/upgrade footguns before they become "why is the
daemon not coming up" tickets-to-self.

### What ships

- `factory doctor` runs a fixed checklist and prints pass/fail per
  check:
  1. `bun --version` ≥ minimum supported.
  2. `git --version` present.
  3. `~/.config/systemd/user/factory.service` exists.
  4. `systemctl --user is-active factory` == active.
  5. `/health` reachable, version matches checkout HEAD.
  6. Checkout's `origin` URL points at the upstream Factory remote
     (warn if it doesn't — could be the dev checkout, which is fine,
     but flag it).
  7. `~/.factory/config.yaml` parses; `upgrade.channel` is one of
     `stable | nightly | dev`.
  8. `loginctl show-user $USER` reports `Linger=yes` (warn if no —
     daemon won't survive logout).
  9. `~/.factory/data.db` opens read-only; migrations table exists
     and reflects the checkout's migration count.
- Exit 0 if all pass, 1 if any fail. Soft warnings don't change exit
  code (already covered: `--strict` flips warnings to failures, for
  CI use).

### Implementation

- `apps/cli/src/commands/doctor.ts` runs each check sequentially,
  collects results, renders a table.

### Done criteria

- Fresh post-install host: doctor prints all green.
- Stop the daemon: doctor flags 4, 5 red; rest green.
- Edit `config.yaml` to break `upgrade.channel`: doctor flags 7 red.
- `apps/cli/test/doctor.integration.test.ts` covers each check's
  pass and fail paths against a fixture host.

-----

## What this batch deliberately doesn't ship

- **Auto-rollback.** The decision was forward-only for now; if a
  migration breaks the upgrade, the operator runs `git checkout
  <prior-sha>` manually. Backlog: `factory rollback` that consults
  the upgrade-log + last-good.sha.
- **macOS support.** systemd user unit only. Backlog: a `launchd`
  plist generator under `factory install --target=launchd`.
- **Multi-host.** This is single-operator-on-one-host. No fleet, no
  remote management.
- **Authenticated channels / signed releases.** `git fetch` against
  GitHub's HTTPS is the trust boundary for now. Backlog: GPG-signed
  tag verification in `factory upgrade`.
- **Auto-upgrade.** No cron, no daemon-side "check for updates."
  Operator runs `factory upgrade` deliberately.
