# Autonomous & Proactive Factory — State of the Field, and Where Heimdall Goes Next

*Research report · 2026-06-27 · grounded in (a) the field's thought leadership, (b) the product
landscape, (c) Factory's own production data, (d) the operator's Claude Code usage. Five parallel
research agents; sources cited inline.*

---

## 0. The one-paragraph thesis

Factory has already won the part of "autonomous coding" that the entire industry is stuck on —
**trustworthy unattended integration**. The production data is unambiguous: ~99% of completed runs
auto-merge to `main` cleanly (2 true conflicts in 142 merges over six weeks), autonomous chains run
**up to 11 runs deep**, and the operator services a near-empty inbox in minutes. The whole rest of
the field punts merge-time to a human; Factory does not. So the question is *not* "how do we remove
the human" — the merge human is already gone. The question the data actually poses is: **the human
is now a judgment bottleneck (~0.6 decisions per run, dead flat as volume tripled), and that
judgment splits cleanly into one half that is safely automatable and one half that is irreducibly
human.** The path to human-out-of-the-loop is therefore not "rip out gates." It is: *shrink the
inbox by expanding automatic verifier coverage, and convert the residual human attention from
reactive interrupts into asynchronous, anticipated, and self-generated proactive review.* That is a
three-gap fill on seams that already exist — not a rewrite. The codebase already implements five of
the field's six load-bearing mental models. This report names the three it doesn't, and proposes the
features that close them.

---

## Part I — The state of the field: six load-bearing mental models

The field converged hard in 2026. Frontier models are within harness-noise of each other on
SWE-bench Verified (~85–90%), so competition moved to **the harness, the trigger surface, and the
verification layer**. The mood is post-hype "calibrated pragmatism": generation is free, *trust is
the bottleneck*, and humans-in-the-loop-at-merge is the consensus floor. Six models matter.

**MM1 — Autonomy = verifier coverage.** *(Karpathy; Jason Wei's "Verifier's Law")* "Traditional
computers automate what you can specify in code; LLMs automate what you can verify." You may remove
the human exactly as far as a deterministic/trusted check can adjudicate the output — no further.
Every increment of autonomy must be *paid for* with an increment of automatic verification.
Spec-driven development is the enabler precisely because writing acceptance criteria up front
*manufactures the verifier before the work exists*. **This is the single most important model.**

**MM2 — Autonomy is an earned, auto-moving trust score, not a config flag.** *(Karpathy's "autonomy
slider"; Monte Carlo; Anthropic's measurement that auto-approve rises 20%→40%+ as users gain
experience)* Start in-the-loop, widen as the track record proves out, and **contract automatically
the instant failure-disposition degrades — no committee.** Run the fleet at a high autonomy level
*inside isolation*; present a low-autonomy console *over* it. The enemy the whole literature fights:
automation complacency under multi-task load (the reviewer who rubber-stamps a usually-right fleet).

**MM3 — Parallelize reading, serialize writing.** *(Anthropic's multi-agent research system ×
Cognition's "Don't build multi-agents", reconciled)* Fan-out wins for read-heavy, independent,
breadth-first work (+81% measured) and *loses* for write-heavy work that must converge on one
coherent artifact (−70%). Coding is mostly the latter. So fan out *across* isolation boundaries
(separate tasks / worktrees / projects), never *within* a single feature — and push parallelism
upstream into planning, audit, and option-scouting. Budget the ~15× token tax deliberately.

**MM4 — Simplest thing that works; spend autonomy only where structure demands it.** *(Anthropic,
"Building effective agents")* Keep the control plane a deterministic *workflow* (queue, branch,
merge, conflict-abort); reserve agentic freedom for *inside* the run. The harness, not the model,
captures most of the gain — Ng's classic result: an agent loop took GPT-3.5 from 48% → 95% on
HumanEval, beating the model upgrade.

**MM5 — Reliability is a horizon problem; containment buys autonomy.** *(METR; Cognizant MAKER;
Chroma's "context rot"; Bezos one-way/two-way doors)* Error compounds as (1−e)^N and context decays
as it grows, so keep each unit *short, lean-context, checkpointed*. Classify every action on
reversibility × blast-radius. The counterintuitive result: a sandbox is not a restriction on
autonomy — it is the *precondition* for it (sandboxed agents stop ~40% less; Anthropic reports ~84%
fewer permission prompts once blast radius is contained).

**MM6 — The inbox is the autonomy slider; escalation is a tool call.** *(LangChain "ambient agents"
/ "agent inbox"; 12-Factor Agents F7)* The human interface to many async agents is a reviewable
*queue of interrupts*, not a live session — with a graduated **notify / question / review
(approve · edit · respond · ignore)** grammar, a sync escape hatch per item, and the operator able
to downgrade items `review → notify` as trust grows. A clean `blocked` is a *success*; the only
thing more expensive than an agent that stops to ask is one that confidently merges the wrong thing.
Escalate on **observable risk type, not self-reported confidence** (verbalized confidence is
systematically overconfident).

### What the products converged on (steal-list)

- **Verify by real execution, not diff-checking** — Cursor attaches computer-use *video proof* to
  the PR; Sweep/Tembo run your actual CI in a pinned sandbox; Datadog iterates to green *before* a
  human sees the PR. *If you steal one theme, steal this.*
- **Verify with a different model than you built with** — Factory's worker/validator split,
  Zencoder's cross-*provider* review "immune system," Anthropic's adversarial peer debate. A model's
  blind spots correlate with its own output.
- **Repo-canonical artifacts** — `AGENTS.md`, in-repo rules/memory (CodeRabbit Learnings, Goose
  Recipes, gptme "brain-as-repo"). Value survives a DB wipe. *(Factory already does this.)*
- **Snapshot/restore environments** — Devin "Machine Snapshots," E2B/Daytona/microsandbox. Provision
  once, boot warm.
- **Linear's Agent Session** — the best single intake design in the field: agent is a first-class
  workspace user; *delegate ≠ assign* (human stays accountable); a 6-state machine driven from a
  typed activity transcript; `elicitation → awaitingInput` is the *only* structured HITL pause; a
  heartbeat contract. Locked to Linear — nobody has generalized it.
- **Self-generated work intake** — Google Jules "Suggestions" scans the repo and *proposes its own
  tasks*; Devin/Codex self-schedule and carry state between runs.
- **Confidence-gated graduated autonomy** — Sentry Seer auto-triggers only on ≥10 events AND ≤14
  days AND a fixability score; Graphite ships *precision-as-product* (sub-3% false positive,
  deliberately low recall, so it's trusted enough to be ambient).
- **microsandbox network-layer secret substitution** — the guest holds a placeholder; the real
  credential is swapped in only on a verified TLS handshake to an allowlisted host. Closes the
  credential-exposure gap of `--dangerously-skip-permissions` *without* a sandbox rewrite.

### The field's open white space (where Factory can lead)

1. **Merge-time, not run-time** — every fleet tool punts the hard part to manual review. Factory's
   auto-merge-on-green-in-a-worktree is *already ahead*; the white space is making it trustworthy at
   scale via execution-evidence + a verifier gate.
2. **A bounded, operator-visible retry budget that hands back on exhaustion** — the single
   most-cited gap across CI-fixers (only one product does it). Maps *directly* onto `done|blocked|failed`.
3. **A backend-agnostic intake primitive** generalizing Linear's Agent Session across
   issue/Slack/cron/error/CI.
4. **Ambient self-generated work feeding a *single* attention sink** — nobody has nailed an agent
   that proposes its own queue while respecting one operator's finite attention. *This is literally
   Factory's design constraint.*
5. **Low-attention, phone-first review surfaces** — Jules' "audio changelog" is the only gesture
   toward out-of-band consumption; the field still assumes a keyboard and a diff.

---

## Part II — Factory today, by the numbers

*Source: read-only analysis of `~/.factory-live/data.db` (the live prod DB; `~/.factory/data.db` is
empty, `~/.factory-dev/data.db` is stale). Window: 2026-05-15 → 2026-06-26.*

**Portfolio.** 8 projects, 6 `production`-tier, 2 `autonomous`-mode (backbar/codex+gpt-5.5,
backlot/opus). `factory` self-hosts and is 48% of all runs.

**Runs (n=182).** 78% completed, 14% failed, 5% blocked. **85% of all failures are `factory`'s own
known wide-`bun test`-kills-parent bug** — cross-project reliability is materially higher than 78%;
lodestar/mabel/backlot had **zero** failures. Median completed-run duration: 6.9 min.

**Integration is solved.** 142 completed runs → ~99% auto-merged cleanly. Only **2 true merge
conflicts in six weeks**. The v0.1 auto-merge-on-green contract is doing exactly what the rest of the
field is afraid to ship.

**Autonomy already compounds.** 57% of consecutive runs auto-advanced (<2 min apart). Chain-length
distribution tops out at a **single unbroken chain of 11 runs**; ~44% of chains run ≥2 deep. But
**46% of multi-run chains die on a failure/block, not a clean empty queue** — and most of those are
the test bug. *Fixing that one bug directly lengthens autonomous chains.*

**The human is a judgment bottleneck, and it is not improving with scale.** Decisions scaled
*linearly* with runs (~0.6 decisions/run, steady as weekly volume tripled from ~18 to ~60). The
inbox breaks down:

| kind | share | nature | automatable? |
|---|---|---|---|
| **agent_decision** | **42%** | mid-run design forks the agent is *unblocked* on but asks anyway (AST-evaluator vs full parser; seed CSV vs live fetch) | **Yes** — these are confirmations |
| **blocked_run** | **29%** | external dependency: secrets, hardware (Mac mini), third-party accounts, subjective verdicts ("does this feel faithful?", "in use ≥3 weeks?") | **No** — but anticipatable/batchable |
| issue_intake | 14% | external GitHub issue adoption | partial |
| merge_failure | 10% | mostly dirty/wrong-branch, 2 true conflicts | mostly |

**Critical finding:** the two `autonomous`-mode projects *still went through the collaborative
decision flow.* The autonomy flag is not actually suppressing `agent_decision` blocks in practice.
The #1 inbox driver is both the most automatable *and* currently un-suppressed even where the
operator already opted into autonomy.

**Empty tables:** `audits` and `deferred_tasks` have **zero** production rows. The v0.3/v0.4
primitives shipped but are unused.

### What's already autonomous (the seams)

*Source: architecture map of `/home/rnwolfe/dev/factory`.*

- **Auto-advance** (`workers/post-merge.ts:122-158`) — the compounding loop; picks "next ready task
  in file order" (`projects/tasks.ts:100-111`).
- **Per-project `autonomyMode`** (`schema.ts:27,360`) — today only flips `decisionsEnabled=false`
  (`runner.ts:351`) and swaps the prompt footer. The dial exists; it's turned ~10%.
- **Two 60s polling ticks + an EventBus** (`workers/usage-cap.ts`, `inbox-resurface.ts`,
  `events.ts`) — the proactive-cadence pattern already exists; the v0.4-spec'd `workers/scheduler.ts`
  is a third of identical shape (verify whether it actually shipped — the data suggests not).
- **Boot-time reaper** (`workers/recover.ts`) — autonomous restart recovery.
- **Verification machinery** — `factory-status` footer parser (`workers/factory-status.ts:130-161`,
  null-parse→failed, per-criterion acceptance downgrade at `runner.ts:530-531`); `quality.ts`
  (informational, non-gating); audit severity enum (`audits/findings.ts:103-124`).
- **Worker pool** (`workers/pool.ts`) — plain FIFO, fixed concurrency 4, no backlog/priority/fairness.

**The structural invariant** (VISION.md, ADR-004 §9): *the operator is the only path to a repo
write.* The defensible autonomy expansion is **read-mostly + low-risk-write auto-approval gated on
verification confidence** — not removing the merge/approve gates wholesale.

---

## Part III — The gap: how the operator works *outside* Factory

*Source: analysis of `~/.claude/` — 115 project dirs, 960 subagent invocations, settings, skills.*

The operator runs raw Claude Code with `defaultMode: bypassPermissions`,
`skipDangerousModePermissionPrompt: true`, `effortLevel: high`, `model: opus`,
`remoteControlAtStartup: true`, `agentPushNotifEnabled: true`. **He has already removed the
permission gate and steers agents from his phone while AFK.** He fans out aggressively (22-agent and
19-agent single batches; 92 worktrees; an 11-worktree burst in one hour). And — most telling — *he
has wrapped every recurring ritual he has in a skill*: `release`, `ship-pr` (watch CI → address
review → merge on green), `overnight-run` (an explicit human-out-of-the-loop operating contract),
`monthly-money-review` ("good as a /schedule or /loop cadence on the 1st"), `improve-dotfiles`,
`loop`, `schedule`, `deep-research`, `harvest-docs`, the `cli-plan→scaffold→implement→publish` suite.

**The skills are a map of what he wants Factory to do autonomously.** Two gaps fall out:

1. **Factory is reactive; he wants proactive.** Work in Factory starts from triage/plans/issues — all
   human-initiated. He hand-rolls proactivity with `/loop` and `/schedule` *outside* Factory. The
   missing primitive is **cadence + ambient self-generated work** — the exact white space (#4) the
   field hasn't filled, and the exact thing the Heimdall ("the watchman who sees and hears all")
   rename is begging for.
2. **Factory is narrower than how he actually works.** Worker-pool-of-4 vs his 5–10-at-a-time; no
   first-class overnight mode though he literally types *"do an overnight run for this entire epic."*

**Trust requirements he has already written down** (`tasks/lessons.md`, memory feedback files) — the
non-negotiable guardrails any OOTL mode must honor: never run long-lived processes (he owns the dev
loop), prod is read-only for diagnostics (a restart kills live sessions), `main` is sacred (PRs
only, no force-push), never invent scope (a clean early finish is a feature), never silently claim
success (the factory-status contract), reproduce-before-fixing, and *persist what you learn*
(add lessons proactively, no asking).

---

## Part IV — Proposals

Ordered by leverage. Each names the seam, the mental model it pays off, and the field pattern it
steals. **A–C are the three-gap fill and the core recommendation. D–F extend it. G is the
outside-the-box layer. H is the "new stack" option, named and then declined.**

### A. The Trust Ladder — turn `autonomyMode` into a graduated, auto-contracting score `[MM2, MM6]`

**Gap:** the autonomy dial is binary and only suppresses mid-run decisions — and the data shows it
isn't even doing that for `agent_decision`. **Build:** replace the `collaborative|autonomous` enum
with a per-(project × task-class) **trust level L1–L4** (Operator → Collaborator → Approver → Observer):

- **L1** — every decision to the inbox (today's collaborative).
- **L2** — `agent_decision` design-forks auto-resolve to "the most defensible path" and post as a
  `notify` (not a `review`) with the chosen fork + reasoning. *This alone removes ~42% of the inbox.*
- **L3** — L2 + low-severity audit findings auto-promote; `blocked_run` retries on transient causes
  auto-fire within a bounded budget before escalating.
- **L4** — L3 + the project self-directs its next work (see B).

The level **moves automatically**: it ratchets up after N consecutive clean auto-merges with
verifier-green (the data is right there in `runs`), and **contracts the instant** a run fails, a
merge conflicts, or the operator overrides an auto-resolved fork. Surface the current level + its
trend in the project header next to the existing TierPicker. **Seam:** `schema.ts:27`,
`runner.ts:351`, `factory-status.ts:415-434`, `projects/bootstrap.ts:182`. The plumbing (enum,
footer-swap, bootstrap default-by-tier) all exists — you extend the *policy*, not the wiring. **Fix
first:** make autonomous mode actually suppress `agent_decision` (it currently doesn't).

### B. The Watch — a proactive scheduler + ambient self-generated work `[MM6, white space #4]`

**Gap:** no cadence, no proactivity, empty `audits` table. **Build** `workers/scheduler.ts` (the
v0.4 design, same shape as the two existing 60s ticks + EventBus). It owns two things the operator
currently hand-rolls with `/loop` and `/schedule`:

1. **Cadence** — periodic backlog grooming; "decompose the next milestone when a project's ready
   queue drains" (instead of just emitting `queue_empty`); scheduled health audits (finally
   exercising the audit primitive); doc-drift checks at release; dependency-update sweeps. Each
   result lands in the inbox as a `notify`/`question`.
2. **Ambient self-generated intake** (steal Jules "Suggestions") — a read-only watcher that scans
   each project's repo, open issues, error stream, and prior audit reports, and **proposes its own
   tasks** into the inbox. Heimdall stops waiting to be told what to do.
3. **The out-of-band-work watcher (the operator's enhancement — the single highest-novelty idea
   here).** A periodic task reads the *local host's* `~/.claude/projects/*` transcripts and
   `~/.codex/` history, catches up on engineering the operator did *outside* Factory, and
   **synthesizes it into memory** — what he built, what patterns recurred, what corrections he made,
   what new skills/conventions emerged. This closes Factory's biggest blind spot: today it has no
   awareness of the 5–10 agents the operator runs elsewhere (115 Claude Code project dirs, 960
   subagent calls). With it, **memory stops being operator-curated and becomes Factory-earned** —
   the system learns the operator's evolving conventions, surfaces "you keep doing X by hand, want me
   to own it?", and grounds every future autonomous run in the operator's actual current practice.
   This is the literal embodiment of the Heimdall rename: the watchman who sees across all realms,
   not just his own gate. Read-only over `~/.claude`/`~/.codex`; respects the `.env*` deny rules;
   writes only to the memory store and the inbox (never a repo).

This is the reactive→proactive flip, and it's the field's biggest unclaimed white space *because*
nobody else has a single-attention-sink to feed. **Seam:** `index.ts:189-190` (start it alongside the
existing ticks), `events.ts` (`run_merged`/`plan_frozen`), `inbox/queue-empty.ts:53`,
`post-merge.ts:122-158`. Honor the skip-if-inflight discipline already designed in ADR-004.

### C. The Verifier-Coverage Gate — make "is this safe to land unattended?" a measured score `[MM1]`

**Gap:** auto-merge gates on `finalStatus==="completed"`, but "completed" ≠ "verified." **Build** a
**verifier-confidence score** per run, composed from signals that already exist: factory-status
`done` + *all* acceptance criteria met (`runner.ts:530`) + quality green (`quality.ts`) + (new)
cross-model validation. The score, combined with a reversibility/blast-radius classification of the
diff, decides routing: **high confidence + contained → auto-land silently; low → `review` in the
inbox.** Critically, make **frozen, testable acceptance criteria a freeze precondition** — *no
checkable criteria = not autonomy-eligible.* This is MM1 made operational: the inbox is the residual
of unverifiable work, so expanding verifier coverage *is* shrinking the inbox. **Seam:**
`factory-status.ts:130-161`, `runner.ts:71-98,530-531`, `quality.ts`, `audits/findings.ts:103`.

### D. Cross-model adversarial validation — the immune system Factory is uniquely set up for `[MM1, steal: Zencoder/Factory.ai]`

Factory already runs **two model families** (`projects.agent ∈ {claude-code, codex}`, fused with
`model`). Route each run's verification to the *other* family (claude builds → codex validates, or
vice-versa), because a model's blind spots correlate with its own output. This is nearly free given
the existing `AgentModelPicker` and submit-time resolution, and it's the strongest possible input to
the Part-C confidence score. The actual Factory.ai company ships exactly this (`--worker-model` /
`--validator-model`); the operator's Factory can too, with no new auth.

### E. The Provisioning Manifest — anticipate `blocked_run` instead of discovering it mid-run `[MM6]`

29% of the inbox is structurally-human external dependencies (secrets, hardware, verdicts) — *and
the agent discovers them mid-run, one at a time.* Instead: at plan-freeze, have the agent emit a
**provisioning manifest** — everything it will need that only the human can supply — batched into
**one** decision up front (steal Linear's pre-assembled `promptContext`). The human provisions once;
the run executes uninterrupted. Turns N mid-run stalls into one pre-flight checklist.

### F. Overnight Mode as a first-class run contract + the Backlog-Pull Fleet `[MM2, MM3, MM5]`

Promote the operator's `overnight-run` *skill* into a Factory **run mode** with the guardrails baked
in (no force-push, `main`-via-PR-only, no prod restarts, no long-lived processes, no scope invention,
auditable morning report) — he literally asks for this by name. And widen the worker pool
(`pool.ts`) from FIFO-of-4 into a **prioritized cross-project backlog pull** with per-project
fairness/locks — "a fleet of N workers pulling the highest-value ready work across the whole
portfolio," matching how he actually works. Parallelize *across* projects (MM3); the per-run worktree
keeps writes serialized *within* a feature.

### G. Outside-the-box layer

- **Execution evidence on the merge** (steal Cursor/Cubic) — as the human reviews less, every
  auto-landed run attaches a *verification narrative*: the acceptance criteria with pass evidence,
  the cross-model validator's verdict, a structured `{reasoning, finding, confidence}`. The artifact
  explains itself. Pairs with a **phone-first / audio changelog** (steal Jules) for the operator's
  push-notify-and-walk-away posture.
- **Lessons-as-context loop** (steal gptme "brain-as-repo") — wire `tasks/lessons.md` so autonomous
  runs *read* prior lessons as context and *write* new ones on correction. He already wants this
  ("add lessons proactively, don't ask"); make it the system's, not just his.
- **Credential hardening without a sandbox rewrite** (steal microsandbox) — network-layer secret
  substitution against an allowlist, closing the `--dangerously-skip-permissions` exposure that MM5
  flags, cheaply.

### H. The "new stack" option — named, then declined

The maximal version reframes Factory from *task executor* to *standing autonomous engineering org*:
a permanent fleet with a trust economy, an ambient work generator, and the operator as pure
fleet-manager over an inbox. **It's the right north star — but it's a re-skin of what A–F already
build incrementally, on seams that already exist.** The data says Factory is architecturally ~80%
there; a rewrite would discard the hardest-won, field-leading assets (auto-merge-on-green, worktree
isolation, the honest-completion footer, the single attention sink). **Recommendation: evolve, don't
rebuild.** Ship A–C as the v0.x autonomy arc; D–G as fast-follows. The north star is reached by
turning the dials that exist, not casting new ones.

---

## Part V — Sequencing

1. **Fix the `bun test` self-kill bug.** It causes 85% of all failures and severs ~half of all
   autonomous chains. Highest ROI in the entire report; pure subtraction.
2. **A (Trust Ladder L2)** — make autonomous mode actually auto-resolve `agent_decision`. Removes
   ~42% of inbox; the dial already exists.
3. **C (Verifier-Coverage Gate)** — the principled enabler that makes widening the ladder *defensible*.
4. **B (The Watch)** — the reactive→proactive flip; the field's biggest white space and the Heimdall thesis.
5. **D, E, F, G** — fast-follows that compound A–C.

**The measure of success is a single number: decisions-per-run trending toward zero while
auto-merge stays at ~99% and failures stay flat.** That is human-out-of-the-loop, earned rather than
declared.
