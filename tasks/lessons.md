# Lessons

Rules-for-future-Claude distilled from corrections in this repo. Read at
session start; update after any user correction.

- **`-webkit-line-clamp` (`display:-webkit-box`) leaks its *intrinsic* height
  into block flow on WebKit/iOS Safari — fix with `[contain:layout]`, NOT by
  touching `overflow-wrap`.** Symptom: a decision card with a long `summary`
  shows a 2-line headline, then a ~340px empty gap, then the question/buttons
  pinned below. Proven mechanism (measured in real WebKit): the clamped div has
  `offsetHeight≈47` (2 lines, visually clipped) but `scrollHeight≈397`, and that
  scrollHeight leaks into the parent block flow, pushing the next sibling down by
  the un-clamped height. **Blink is unaffected — it only reproduces on iPhone.**
  The question `<span>` never gapped because it's a *flex item* (flex sizes
  children by border-box, absorbing the leak); the headline `<div>` is a block
  child, so it leaks. Fix: add `[contain:layout]` to every line-clamped
  *block-context* element (`apps/pwa/src/components/decision-card.tsx` headline +
  rationale/message/context `<p>`s). Two false starts cost a wrong release
  (v0.28.1 removed `overflow-wrap` — a no-op): **a `-webkit-line-clamp` gap that
  only shows on one engine MUST be reproduced in that engine before fixing.**
  Playwright `webkit` on this host needs `sudo playwright install-deps webkit`
  (libgtk-4 + media libs); drive the real app via `localStorage['factory.token']`
  against `http://localhost:4082`, and compare `offsetHeight` vs `scrollHeight`
  to find the leaking node. (2026-06-26)
- **The live host (`factory.service`, port 4082, `~/.factory-live` data) runs
  the daemon from the dev checkout (`/home/rnwolfe/dev/factory/apps/daemon`,
  HEAD) but serves a *pre-built* PWA `dist` (`apps/pwa/dist`, last `bun run
  build`).** So a frontend source fix on HEAD is NOT live until the PWA is
  rebuilt + the daemon redeployed/restarted; the dev vite server (4081, HMR)
  does reflect HEAD immediately. When diagnosing a UI bug from a screenshot,
  read the actual served bundle (`apps/pwa/dist/assets/index-*.js`) — it may
  lag HEAD. (2026-06-26)

- **A code-changing run can't cleanly push to origin — it lives in a per-run
  `factory/run-*` worktree, and `mergeIntoMain` (worktree.ts) merges into the
  project's *local* `main` only, after the run, and never pushes.** So any
  task body that tells the agent to "push `main`" pushes a stale ref (the run's
  commit isn't on `main` until the post-run merge). Anything that must update
  origin (a release: bump + tag + push) needs the push to happen from the
  project main checkout *after* the merge — a post-merge step — not from inside
  the run. Designing release execution as "just a normal run driven by the task
  body" (ADR-008's first cut) was wrong for exactly this reason; living with it
  on a real project surfaced it. (2026-06-14)

## Read the diff before defending architecture

When investigating a regression, look at the actual commit diffs before
drawing architectural conclusions. The system's *default* code paths
and its *recovery/intervention* paths often guarantee different things,
and the recovery paths bypass the guardrails.

Example: I claimed "auto-committed residual changes stay on the run
branch and never reach main." True for `runner.ts`'s default path.
False for the `merge_failure` decision intervention path, which
operator-merges the run branch (auto-commit and all) into main without
diff review. Result: a `chore: auto-commit residual changes` commit
landed on main, regressed the PWA's run-event renderer (re-introduced
the very perf problem the prior code documented and avoided), shipped
in v0.9.0, hung the operator's run-detail page.

**Rule:** before saying "X never happens," check git log for
counter-examples. If the user is challenging a sweeping claim, trust
their observation over a code-only reading.

## Agent auto-commits are unreviewed by definition

`chore: auto-commit residual changes · <task> run <id>` commits are
the runtime's safety net for an agent that wrote files but didn't
commit them. They are NOT operator-reviewed. They contain whatever
state the worktree had when the agent died — including changes that
reverse deliberate prior decisions.

**Rule:** when handling a `merge_failure` decision or any intervention
flow that proposes merging a run branch to main, surface the diff to
the operator before merging. Never automate "merge a branch that
contains an `auto-commit residual changes` tip" without a diff gate.

If a comment in the code explicitly explains why a deliberate choice
was made ("plain pre because markdown rendering on hundreds of events
locks the main thread"), do not remove the comment + change X to ¬X
without acknowledging the warning. Memoization does not help initial
paint.

## When fixing a prod regression, prefer revert + hotfix over force-push

v0.9.0 was pushed and the operator's daemon was already on it when the
regression surfaced. Two paths:

- **Revert + v0.9.1:** `git revert -m 1 <merge>` adds a clean undo
  commit. v0.9.0 history stays valid; `factory upgrade` picks up the
  hotfix cleanly. Adds one commit of noise.
- **Force-push + retag v0.9.0:** Rewrites published history,
  invalidates the sha the daemon already installed, requires the
  daemon to forced-re-fetch.

**Rule:** for a regression in a published release, default to
revert + bump-patch. Force-push is only reasonable when no consumer
has the bad sha yet — and as soon as a single `factory upgrade` ran,
that's no longer true.

## The upgrade checkout can also be a project workdir — design accordingly

The common single-host operator setup has one Factory repo serving
two roles: (a) the source `factory upgrade` checks out the channel
sha into; (b) the workdir of a Factory project tracking the Factory
repo itself.

Previously, `factory upgrade` did `git checkout --detach <sha>`,
which left the project workdir on detached HEAD. The runtime's
`mergeIntoMain` refuses to merge run branches into a detached HEAD,
so every upgrade silently broke the next merge of any factory-project
run. The operator only noticed when a run completed and the merge
failed with `wrong-branch: project HEAD is on '(detached)'`.

Fixed in `apps/cli/src/upgrade/checkout.ts`: when the operator was on
a named branch, FF the branch to the sha and stay on it. Non-FF
falls back to detached (preserves local commits on the branch ref).

**Rule:** any code that mutates state in a directory has to consider
that the directory may serve multiple purposes. "It's just our
checkout" is a lie when the operator's setup overlays it on something
else.

## Self-updating bootstrap loops need a manual install at least once

`factory upgrade` rebuilds `apps/cli/dist/factory` mid-run so CLI
fixes ship to the operator's `~/.local/bin/factory` symlink on the
next invocation. The catch: the running upgrade IS the old binary, so
this step only exists if the operator's installed CLI was built from
a sha that already includes the step. Otherwise the fix is dormant
indefinitely — every upgrade copies new src/ into the checkout but
never recompiles the binary the symlink actually targets.

Real example from this session: I shipped v0.9.2 with the upgrade-
preserves-branch fix. Two consecutive `factory upgrade` calls both
silently kept the old behavior. The cause: the operator's installed
binary was from May 9 23:08, two minutes before `c459ea6 fix(cli):
factory upgrade rebuilds the CLI dist` landed at 23:10. The upgrade
flow's self-update step never got a chance to install itself.
Bootstrap required: `bun run cli:install`. After that, future
upgrades self-sustain.

**Rule:** when shipping a fix to a tool that's responsible for
delivering its own future fixes, check that the running version
already contains the delivery mechanism. If not, the operator needs
a one-time manual install — surface this explicitly in the release
notes / upgrade output. Don't assume "they'll get it on next
upgrade" — the upgrade itself may be the dormant code.

## Don't wire Anthropic subscription usage polling into Factory

The OAuth token in `~/.claude/.credentials.json` (`claudeAiOauth`)
contains the operator's Claude.ai subscription credentials, including
`subscriptionType` and `rateLimitTier`. Third-party tools like
`ccusage` use endpoints such as `/api/oauth/account/settings` and
`/api/claude_code/policy_limits` to render live "% of 5h cap" UIs.
The temptation is to do the same in Factory's ticker.

**Don't.** Three independent reasons:

1. **Anthropic's docs scope the OAuth token to "inference only."**
   Account/usage endpoints are explicitly outside the documented
   scope. Multiple third-party writeups characterize use by non-
   Claude-Code consumers as a Consumer-TOS edge case. We're not
   `claude.ai` and we're not `claude` — Factory is an automation
   layer that uses `claude --print` (which IS allowed), but if we
   reach past the CLI to hit Anthropic's account APIs ourselves,
   we're a different consumer.

2. **Endpoints are undocumented and unstable.** `ccusage` and similar
   trackers exist *because* this works, and they break + chase the
   changes regularly. Factory doesn't want that maintenance burden.

3. **Starting 2026-06-15 the metric becomes the wrong one entirely.**
   `claude --print` (Factory's only path to Claude) and Agent SDK
   usage move to a *separate* monthly Agent SDK credit, decoupled
   from the 5-hour / weekly subscription windows the ticker would
   be measuring. Even if polling worked perfectly, we'd be showing
   `0%` against a cap that doesn't include our spend. There's no
   public API for the Agent SDK credit balance — Anthropic's own
   support article confirms it.

**What we ship instead (v0.10.1+):** `claude_metrics`-derived dollars
+ tokens, calendar-aligned (today / this week / this month). The
monthly window matches Anthropic's Agent SDK credit reset cycle, so
operators can eyeball "have I blown my $100 (Max 5x) / $200 (Max 20x)
SDK credit this month." Operator-configured caps (if anyone needs
hard limits later) belong on our own metrics, not subscription %s.

**Rule:** Factory tracks what Factory spends. Subscription-side
metrics belong on Anthropic's own dashboards (and `ccusage` if the
operator wants live %). If a future ask is "show subscription cap %
in Factory," push back: it's the wrong primitive, it has TOS risk,
and after 2026-06-15 it measures the wrong thing.

## Don't ask the operator about adding lessons — just add them

When a session surfaces a non-obvious fact (an Anthropic policy
shift, a TOS interpretation, a load-bearing comment that future-
Claude would re-derive painfully), write the lesson directly. Don't
ask "want me to add a lesson?" — the operator told me explicitly
2026-05-24 that the asking is friction; the choice of whether to
preserve session learnings is mine to make based on whether the
content is durable + non-obvious.

**Rule:** add lessons proactively when shipping changes that turned
on hard-to-rediscover context. Skip the meta-question; just write
the entry inline with the related commit.

## Prod is read-only for diagnostics. Debug in dev.

When investigating a bug that's reproducible in the operator's
environment, the temptation is to ship a quick `console.log` to prod
to see what's happening. **Don't.** Shipping a diagnostic-only build
to prod requires a `factory upgrade`, which restarts the daemon,
which kills every running session and in-flight run. The cost of
that restart — lost shell sessions, aborted runs, operator context
disrupted — is almost always worse than the time saved by skipping
the dev-side replication.

**Rule:** the dev daemon (`factory-dev.service`, port 4080 + vite on
4081) is the right place for diagnostic logging. Bun --watch
auto-reloads dev on source changes, so adding a `console.log` is
zero-cost. Reproduce the bug against dev, find the root cause, ship
ONE clean fix to prod. Prod sees a single upgrade, not two (one for
diagnostics + one for the fix).

Concretely:
- `journalctl --user -u factory-dev -f` for dev daemon logs.
- Both dev + prod read from `/home/rnwolfe/dev/factory`, so source
  edits made for dev debug are visible to prod's NEXT upgrade —
  remember to revert diagnostic logs before bundling with the fix.
- Read-only investigation against prod (sqlite queries, tmux probes,
  `git log`, journal inspection) is fine and often necessary —
  that's information gathering, not mutation.
- Real example, 2026-05-24: I shipped v0.10.5 to prod with
  diagnostic `console.log` lines because I was lazy about
  replicating the typing-input bug on dev. The factory upgrade
  restart killed the operator's in-flight shell session. The user
  correctly called this out as a violation of the principle.

## iOS PWA bottom-nav drift: fix the layout, not the fixed-position CSS

Symptom: the mobile bottom nav (and the feedback FAB) drift up into
mid-content as you scroll on an installed iOS PWA, instead of anchoring to
the screen bottom. The nav and FAB drift *together* — the tell that they
share a broken fixed-positioning context, not that one element is mis-styled.

What does NOT work (chased twice — task-023's scroll-bounce tweak and the
v0.20.1 `overscroll-behavior: none` line): incremental CSS patches on a
`position: fixed; bottom: 0` element. The root problem is reliance on
viewport-fixed positioning under an iOS *body-scroll* model. iOS standalone
Safari resolves `fixed` against a context that drifts with momentum scroll,
and `background-attachment: fixed` on `body` is a documented aggravator.

The fix that holds (v0.20.2): make the shell a `100dvh` flex column where
`main` is the *sole* scroll container (`flex-1 min-h-0 overflow-y-auto`) and
the nav is a normal flex child (`shrink-0`) — no `position: fixed` at all, so
there is nothing for iOS to mis-resolve. Body no longer scrolls, so also drop
`background-attachment: fixed` (becomes a visual no-op). Retarget any route
that hardcoded the old overlay geometry (live-pane's
`calc(100vh - 56px - 72px - insets)` → `min-h-full`).

General rule: when a `position: fixed` element misbehaves on iOS and you
can't find a transformed/contained ancestor in the source, stop patching the
fixed element. Convert to a flex/grid layout where the element's position is
structural and cannot escape. Correct-by-construction beats fighting WebKit's
fixed-positioning quirks you can't reproduce off-device.

## Installed iOS PWA: `100dvh` ≠ full screen — use `100lvh`; and instrument on-device before guessing

Symptom: a mobile bottom-nav fix that the operator reported as "still too tall /
large gap on the bottom" across *seven* releases (v0.20.2 → v0.21.7). I kept
adjusting the nav's own height/padding from phone screenshots; nothing helped.

Root cause (the real one): the responsive shell root was `h-[100dvh]`. In this
**installed (standalone) iOS PWA, `dvh`/`svh`/`vh` all resolve to the
status-bar-excluded height** — on-device the probe read `scr932 inner873
dvh873 svh873 vh873 lvh932`. So `100dvh` = 873 on a 932px screen, and because
the shell is top-anchored, the **59px shortfall surfaced as a strip of page
background below the nav**. No amount of nav padding/height could fix it — the
*container* didn't reach the screen bottom. Fix: root → **`h-[100lvh]`** (the
only unit equal to the full physical screen here).

Why it took so long (the process failure, worse than the bug):
- I diagnosed from screenshots where `--color-bg` (5% L) and `--color-bg-1`
  (8% L) are indistinguishable, so I couldn't tell "tall nav" from "gap below
  nav," and shipped ~4 blind CSS guesses.
- My *first* instrument was wrong too: I measured `gapBelow = innerHeight -
  nav.bottom`, but `innerHeight` is *itself* the short value (873), so it read
  `0` and hid the strip. I also wrongly blamed the service-worker cache — that
  SW does not even cache assets, and the daemon already serves index.html
  `no-cache` + hashed assets `immutable`, so there was never a staleness bug.

Rules for next time:
- **iOS standalone PWA + a full-height shell: use `100lvh`, not `100dvh`/`100vh`.**
  `dvh`/`svh`/`vh` can resolve to a safe-area-excluded height and leave a
  bottom strip; `lvh` is the full screen. (Confirmed via an on-device unit probe.)
- **Instrument on-device, comprehensively, the moment you can't reproduce** — and
  measure against the *physical screen* (`window.screen.height`) and **all**
  viewport units (`100vh/dvh/svh/lvh` via probe divs), not just `innerHeight`
  (which can be the deceptive short value). One legible probe screenshot ended
  what 4 guesses + 2 half-probes could not.
- After 1–2 misses, STOP shipping fixes; the cost of a wrong guess to a waiting
  operator dwarfs the cost of one instrumented release. (This violated the
  "stop and re-plan when sideways" rule for far too long.)

## tmux isolation: `$TMUX` and Bun's env snapshot (2026-06-27)

Fixing the "wide `bun test` kills the parent run" bug. Two non-obvious facts cost
iterations and twice killed the live Claude Code session during verification:

- **A tmux command run from inside a tmux session obeys `$TMUX`, which OUTRANKS
  `TMUX_TMPDIR`.** `$TMUX` (set in any pane) pins every `tmux` invocation to the
  current server, so `TMUX_TMPDIR` alone does NOT isolate — it's the lowest-priority
  socket selector. Only an explicit `-L`/`-S` flag, or unsetting `$TMUX`, redirects
  to a different server. Verified live: with `$TMUX` set, `TMUX_TMPDIR=$ISO tmux ls`
  still listed the outer session.
- **Bun snapshots a child process's env at spawn; later `process.env` mutations do
  NOT propagate** to `Bun.spawn` children that don't pass an explicit `env`. So
  `delete process.env.TMUX` / `process.env.TMUX_TMPDIR = …` in a test had zero effect
  on the spawned `tmux` — the child still saw the inherited values. The isolation
  lever therefore has to be a **CLI arg computed in-JS** (`-L <socket>`), not an env
  tweak. (If you DO need env mutations to reach a child, pass `env: { ...process.env }`
  explicitly to `Bun.spawn`.)

Rules for next time:
- **Don't verify a tmux/process-killing fix against your own live session.** Stage a
  disposable stand-in (a parent session on a *private* socket, `$TMUX` faked to it)
  so the experiment's blast radius can't reach the session you're running in. This
  caught the broken fix (stand-in parent died) without a third self-kill.
- **A verification harness that can't fail isn't verifying anything.** The staged
  parent that *died* is what proved the env-only fix was wrong; design the check so a
  bad fix produces a visible, contained failure.
- When isolating a shared external server (tmux, a DB, a daemon), prefer an explicit
  per-instance handle (socket/namespace) computed in-process over env-var precedence
  games — env precedence + runtime env snapshots are full of sharp edges.

## `agent_decision` is non-blocking ratification, not a gate (2026-06-27, operator correction)

When reasoning about autonomy and the inbox, do NOT frame `agent_decision` decisions
(42% of inbox landings) as "blocking work that auto-resolving would unblock." They do
not block: the agent already picked the most defensible path and **proceeded / shipped**.
The inbox card exists for **after-the-fact ratification** — the operator ratifies (accept
verbatim) or **overrides**, and an override is a *post-hoc redirect* (`resurface.ts`
re-queues the work as a new `"resurfaced"` task), never a gate on the original run. The
run already continued (architecture brief: agent_decision = "No (run continues)").

Implications for the Trust Ladder / autonomy work:
- The lever for `agent_decision` is **attention / ratification load, not throughput**.
  "Auto-resolve" means *stop demanding mandatory ratification*, not *stop blocking*.
- **The override is what makes auto-ratification safe.** You lose nothing by not ratifying
  upfront, because you can still override after (reviewing the merged work / a digest).
  This is the human-IN-the-loop → human-ON-the-loop move.
- Today's `autonomyMode` is a lossy binary: collaborative = ratify-everything (high
  attention); autonomous = agent doesn't even emit forks, just prose in the summary, and
  the only recourse is "flip to collaborative + re-run" (NO structured override). The
  missing middle — **auto-ratify but keep the structured override** — is the sweet spot.
- Cleanest first lever: L1→L2 is purely daemon-side — create the `agent_decision` row
  with status `actioned` (auto-ratified, flagged) instead of `pending`. The agent's
  behavior (emit forks) is unchanged; override stays available. Zero throughput risk
  because these never blocked.

## /ops vs /metrics are distinct surfaces — place with IA discernment (2026-06-28, operator correction)

When adding a surface to the PWA, do NOT dump the same component on both `/ops` and
`/metrics`. They have different identities:
- `/ops` = real-time **operational awareness** ("what's happening now"): live runs,
  active sessions, current state, the Watch loop's *current* status, headline tiles.
- `/metrics` = **historical analytics** ("how are things trending over time"):
  time-series charts, aggregates, spend trends.

I mounted `AutonomyMetrics` (historical charts) AND `WatchPanel` on BOTH surfaces
without discernment — the operator called it "merged ops into metrics without
discernment." Right placement: historical time-series → `/metrics`; current
operational state (Watch cadence/last-scan/funnel, live tiles) → `/ops`. Decide by
the surface's identity; don't duplicate the same component across both.

## Don't blindly inject cross-project memory into runs — it over-corrects (2026-06-28, operator)

Operator-memory / synthesized insight is **cross-project**. Pointing every run at all of
it pushes some projects the wrong way — e.g. the operator's "Go + kong for CLIs" preference
bleeding into a TypeScript project. I shipped a blanket reading-list pointer into every run;
the operator flagged the over-correction risk. Memory must create value through two **scoped**
channels, never a blanket run pointer:
- **(a) Propose, don't steer:** synthesize → derive insight → propose tasks / bugs / process &
  routine improvements (operator-gated — the Watch generator). Cross-project insight becomes
  *suggested work*, not silent in-run direction.
- **(b) Hone a given project:** project-scoped direction (a project's own AGENTS.md / scoped
  conventions), so only project-relevant direction reaches that project.
Scope before you inject. Corollary: a synthesize-from seed of existing harness memories is
token-heavy → put it behind a settings-triggered "first seed", not auto-on-boot.

## "Prod unreachable" with a healthy daemon → suspect the ingress/proxy, not the app (2026-06-28)

Operator reported Factory prod "continuously crashing / PWA won't load." The daemon was
completely healthy (NRestarts=0, continuous uptime, sub-ms /health, ~0 CPU/IO pressure,
serving fresh bundles; the PWA service worker is push-only with no fetch/Cache so it can't
serve stale assets). The real cause was the **Caddy reverse proxy** (in a Docker container,
`network_mode: host`, config bind-mounted from `~/dev/expose/`): a shared `filter_scanners`
snippet's Tier-2 @discovery rule `abort`ed any path matching `metrics|debug|graphql|…` — which
collaterally killed Factory's own **`/metrics`** SPA route. `abort` closes the TCP connection
with **no reverse_proxy error log**, so Caddy's logs showed zero Factory errors — the only way
to find it was probing each route end-to-end through the proxy (`/` 200 but `/metrics` reset).
Fix: in `~/dev/expose/sites/factory.caddy`, `handle @factory_app path /metrics /metrics/*` →
reverse_proxy first (bypassing the filter), wrap the rest in `handle { import filter_scanners … }`;
`docker exec <caddy> caddy validate` then `caddy reload` (graceful). Lessons: (1) when prod is
unreachable but the process is healthy, check the proxy/ingress layer before the app; (2) generic
app route names (`/metrics`, `/debug`, `/graphql`) collide with anti-scanner proxy filters —
exempt them per-site at the proxy, don't rename the app route; (3) a TCP `abort` leaves no proxy
error log, so probe routes end-to-end rather than trusting "no errors."
