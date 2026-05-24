# Lessons

Rules-for-future-Claude distilled from corrections in this repo. Read at
session start; update after any user correction.

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
