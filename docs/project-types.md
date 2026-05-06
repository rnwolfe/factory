# Project types — ceremony × role

Status: design proposal. Not yet implemented.

## Problem

The current model uses two enums that overlap and don't capture what
operators actually need to express:

```ts
goalEnum = ["me", "learn", "share", "productize"]
tierEnum = ["tinker", "personal", "share", "productize"]
```

Concretely:

1. `share` and `productize` appear in *both* enums with subtly different
   meanings, and the daemon mostly only reads `tier`. `goal` is mostly
   metadata at this point.
2. There is exactly one rubric (`rubric-me-tinker.yaml`). Every project
   at every level shares the same triage logic, which means triage of
   "I want to build a quick CLI helper for myself" runs against the same
   axes as "I want to build a tool I'll publish to npm." That's wrong.
3. There is no way to say "I'm contributing to someone else's project."
   Today, every project bootstrap creates a `project_vision` plan, and
   the feature-plan vision filter applies. Both are wrong for
   contributor work — you don't set the vision, and feature plans
   should align with the upstream project's vision, not yours.
4. Open-source-vs-private isn't represented anywhere. For a `share` or
   `productize` project, license is load-bearing (it changes which
   audits should run, what the README needs, and what the operator
   should be doing differently when accepting outside contributions).

The fix is to separate orthogonal concerns rather than minting a fifth
or sixth tier.

## Proposed model

Two axes plus a metadata field.

### Axis 1: `ceremony` (renamed from `tier`)

How much process and quality investment this project deserves. The
levels stay roughly the same, but two get clearer names:

| Value        | Posture                                                         |
|--------------|-----------------------------------------------------------------|
| `tinker`     | Throwaway, experimental, no obligations to anyone (incl. self). |
| `personal`   | I'll use this regularly, but no other users.                    |
| `shared`     | Other humans will use it. Quality bar is higher.                |
| `production` | Real users / paid / SLA-relevant. Bugs hurt people.             |

Renamed: `share` → `shared`, `productize` → `production`. The verb
forms felt awkward; the past-participle/adjective forms describe the
state of the project, which is what we're actually labeling.

### Axis 2: `role`

The operator's relationship to the codebase.

| Value         | Means                                                                  |
|---------------|------------------------------------------------------------------------|
| `owner`       | Operator sets architecture, vision, scope. All Factory controls apply. |
| `contributor` | Operator is contributing to someone else's project.                    |

`contributor` is the new one. It changes Factory's behavior in load-bearing ways
— see [Behavior matrix](#behavior-matrix) below.

### Metadata: `license`

A nullable text field on `projects` storing an SPDX identifier (`MIT`,
`Apache-2.0`, `AGPL-3.0`, `proprietary`, …) or `null`. This is *not* an
axis — it doesn't drive ceremony or role decisions. It's a fact about
the project that affects:

- Whether a "license check" audit runs (it should for `shared` /
  `production` regardless of OSS vs proprietary, but it asks different
  questions).
- README scaffolding (OSS projects get contributor / license sections).
- What gets committed to publishable history (no internal comments,
  no commit-author leakage to a private email, etc.).

For `contributor` projects, license is whatever the upstream project
uses. Factory should read it from the cloned repo on adoption rather
than asking the operator to repeat it.

## Why not a separate "open-source" tier?

Considered. Rejected because "open source" is a *distribution* fact, not
a *ceremony* fact. An open-source `tinker` project (a 200-line gist on
GitHub) and an open-source `production` project (a library with
stakeholders) need very different ceremony. If we collapse OSS-ness into
ceremony, we lose that distinction.

The 2-axis-plus-metadata split is more expressive without adding rows
to the matrix.

## Why retire `goal`?

`goal` was an early attempt to capture both ceremony and intent in one
field. It muddled the two.

- `goal: me` → `(ceremony=tinker|personal, role=owner)`
- `goal: learn` → `(ceremony=tinker, role=owner)`
- `goal: share` → `(ceremony=shared, role=owner)` — but also overlapped
  with intent-to-publish, which is now a license question.
- `goal: productize` → `(ceremony=production, role=owner)`

None of these capture `role=contributor`. Easier to retire `goal` and
let `(ceremony, role, license)` carry the same information unambiguously.

## Schema delta

```ts
// packages/db/src/schema.ts

export const ceremonyEnum = ["tinker", "personal", "shared", "production"] as const;
export const roleEnum = ["owner", "contributor"] as const;

export type Ceremony = (typeof ceremonyEnum)[number];
export type ProjectRole = (typeof roleEnum)[number];

export const projects = sqliteTable("projects", {
  // ... existing columns ...
  ceremony: text("ceremony", { enum: ceremonyEnum }).notNull(),
  role: text("role", { enum: roleEnum }).notNull().default("owner"),
  license: text("license"),  // SPDX id or 'proprietary' or null
  // tier and goal columns dropped via migration
});

export const ideas = sqliteTable("ideas", {
  // ... existing columns ...
  // Renamed from goalHint. Operator's intent-at-capture; null lets
  // triage default to the operator-level setting.
  intentCeremony: text("intent_ceremony", { enum: ceremonyEnum }),
  intentRole: text("intent_role", { enum: roleEnum }),
});

export const plans = sqliteTable("plans", {
  // ... existing columns ...
  ceremony: text("ceremony", { enum: ceremonyEnum }),  // nullable for legacy plans
  // tier column dropped
});
```

### Migration (Drizzle)

```sql
-- migrations/0017_ceremony_and_role.sql

ALTER TABLE projects ADD COLUMN ceremony TEXT;
ALTER TABLE projects ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE projects ADD COLUMN license TEXT;

UPDATE projects SET ceremony = CASE
  WHEN tier = 'tinker' THEN 'tinker'
  WHEN tier = 'personal' THEN 'personal'
  WHEN tier = 'share' THEN 'shared'
  WHEN tier = 'productize' THEN 'production'
  ELSE 'tinker'
END;

ALTER TABLE projects DROP COLUMN tier;
ALTER TABLE projects DROP COLUMN goal;

-- Same for plans
ALTER TABLE plans ADD COLUMN ceremony TEXT;
UPDATE plans SET ceremony = CASE
  WHEN tier = 'tinker' THEN 'tinker'
  WHEN tier = 'personal' THEN 'personal'
  WHEN tier = 'share' THEN 'shared'
  WHEN tier = 'productize' THEN 'production'
END;
ALTER TABLE plans DROP COLUMN tier;

-- Ideas: rename goalHint, add structured intent
ALTER TABLE ideas ADD COLUMN intent_ceremony TEXT;
ALTER TABLE ideas ADD COLUMN intent_role TEXT;
UPDATE ideas SET intent_ceremony = CASE
  WHEN goal_hint = 'me' THEN 'personal'
  WHEN goal_hint = 'learn' THEN 'tinker'
  WHEN goal_hint = 'share' THEN 'shared'
  WHEN goal_hint = 'productize' THEN 'production'
END;
UPDATE ideas SET intent_role = 'owner';  -- All existing ideas were owner-mode.
ALTER TABLE ideas DROP COLUMN goal_hint;
```

This is a forward-only migration (consistent with project policy). The
backfill is unambiguous because every existing row has a `tier` value,
and all existing operator activity has been owner-mode.

The TierPicker UI component becomes a CeremonyPicker; a separate
RolePicker chip lives next to it on the project header.

## Rubric matrix

Five rubric files seeded into `rubric_versions`:

| File                              | When it's used                                    |
|-----------------------------------|---------------------------------------------------|
| `rubric-owner-tinker.yaml`        | `(role=owner, ceremony=tinker)`                   |
| `rubric-owner-personal.yaml`      | `(role=owner, ceremony=personal)`                 |
| `rubric-owner-shared.yaml`        | `(role=owner, ceremony=shared)`                   |
| `rubric-owner-production.yaml`    | `(role=owner, ceremony=production)`               |
| `rubric-contributor.yaml`         | `(role=contributor, *)` — single rubric, all ceremonies |

**Why one contributor rubric for all ceremonies?** Contributor work
varies less by upstream's ceremony than owner work varies by your own
ceremony. The questions are similar — alignment with maintainer
direction, reviewability, breaking-change risk — whether you're
contributing to a hobby project or a Fortune 500 monorepo. We can split
later if the rubric grows axes that depend on upstream ceremony.

### Selection logic

```ts
// apps/daemon/src/triage/select-rubric.ts

export function selectRubric(idea: Idea, defaults: OperatorDefaults): string {
  const ceremony = idea.intentCeremony ?? defaults.ceremony ?? "tinker";
  const role = idea.intentRole ?? defaults.role ?? "owner";

  if (role === "contributor") return "rubric-contributor";
  return `rubric-owner-${ceremony}`;
}
```

`OperatorDefaults` is settable in `/settings` ("when I capture an idea
without specifying intent, assume…").

`triage/orchestrate.ts` currently does `where(eq(rubricVersions.active,
true))`. That changes to look up the rubric chosen by `selectRubric`,
returning the highest active version of that rubric id. Multiple
rubrics will be active simultaneously.

## Sample rubric (robust style)

Below is the full new `rubric-owner-personal.yaml` to demonstrate what
"effective and robust" looks like — verbose-on-purpose, with positive
*and* negative signals, scoring anchors, and explicit rationale-quality
expectations. The current `rubric-me-tinker.yaml` is too sparse and
gives the agent room to wave its hands.

```yaml
id: rubric-owner-personal
version: 1
ceremony: personal
role: owner

description: |
  Triage rubric for personal-use projects where the operator is the
  owner. The operator will use this regularly but no one else will.

  Mental anchor: "Will I still want this in 6 months without it
  feeling like a chore?"

  Differs from `tinker` in that:
    - Maintenance cost matters. A quick hack that breaks on every
      upstream update isn't acceptable here — the operator will
      actually live with it.
    - The foundation has to leave room to grow without rewrites,
      because the operator will likely build on it.
    - Vision becomes a precondition for feature work — the
      `feature_plan` vision filter applies at this ceremony.

  Differs from `shared` in that:
    - No external users. Onboarding, docs, and license can stay
      informal.
    - Failure tolerance is high — bugs annoy the operator, but don't
      embarrass them or affect anyone else.

axes:

  - id: usefulness
    weight: 0.30
    scoring_guidance: |
      How often will the operator actually use this?

      Strong signals (high score):
        - Solves a problem the operator hits weekly or more.
        - Replaces an annoyance the operator currently has a
          workaround for.
        - The operator can name 2+ recent moments where they would
          have used it if it had existed.
        - It compounds: usage gets better as data or history
          accumulates.

      Weak / negative signals (low score):
        - "Nice to have" framing or "I might use this occasionally."
        - The operator already has a tool that does this acceptably,
          and the new idea is just a marginal improvement.
        - Use case is hypothetical (no concrete moment of need).
        - Hits a problem the operator only encounters once a quarter.

      Anchors:
        - 9-10: operator names 3+ specific recent moments of need.
        - 7-8: clearly solves a real problem; usage cadence ambiguous.
        - 5-6: useful in principle; concrete trigger unclear.
        - 3-4: speculative — would be cool but no driving need.
        - 0-2: idea is purely "wouldn't it be neat if..."

  - id: maintenance_cost
    weight: 0.20
    scoring_guidance: |
      How much ongoing care will this need to keep working over the
      months/years the operator wants to use it?

      Strong signals (low cost, high score):
        - Self-contained: no external services, APIs, or data feeds
          that can change shape underneath it.
        - Stable dependencies — well-maintained libraries on long
          release cycles, not bleeding-edge.
        - Failure modes are obvious and locally recoverable (a clear
          error in the logs, no cascading state corruption).
        - No recurring operator work needed (no daily key rotation,
          no manual data refreshes, no quota tracking).

      Weak signals (high cost, low score):
        - Depends on third-party APIs that break or rate-limit
          unpredictably.
        - Requires periodic data refresh, scraping, or ETL.
        - Has flaky integrations with platforms that update aggressively
          (Apple ecosystem APIs, browser extensions, social media
          platforms).
        - Needs reauthentication, key rotation, or active quota
          management to keep working.
        - State that needs hand-curation (the operator has to
          periodically prune, label, or sort).

      Anchors:
        - 9-10: fire-and-forget. Once built, it works.
        - 7-8: small periodic care (monthly check-in).
        - 5-6: weekly attention or breakage-prone.
        - 3-4: depends on something the operator knows is fragile.
        - 0-2: maintenance burden likely exceeds operator's tolerance.

  - id: agent_buildability
    weight: 0.25
    scoring_guidance: |
      Can a competent agent build a working v1 in 1-3 iterations?

      Strong signals:
        - Clear specification path: the rubric output, plan template,
          and an existing audit set can decompose this without
          significant judgement calls left to the agent.
        - Standard tech stack: TypeScript, SQLite, web UI, CLI — what
          Factory's defaults handle natively.
        - No specialized domains (ML model training, real-time audio,
          distributed consensus, graphics, embedded).
        - Existing code or libraries handle 80%+ of the heavy lifting.

      Weak signals:
        - Requires expertise outside Factory's defaults (Rust, embedded,
          GPU compute, complex networking, native mobile UI).
        - Significant architecture decisions need to be made before any
          feature code can land — many forks in the road, each with
          long-term consequences.
        - Depends on data the operator hasn't yet acquired or licensed.
        - Needs agreement with external systems (OAuth approvals, API
          allowlists, paid tier prerequisites).

      Anchors:
        - 9-10: a good plan + good prompt + 1-2 iterations produces
          a v1 that works.
        - 7-8: solid path, 3-4 iterations to v1.
        - 5-6: doable but the agent will need a few course corrections
          on architecture.
        - 3-4: parts of this are well outside Factory's sweet spot.
        - 0-2: not feasible without operator co-authoring most of it.

  - id: foundation_quality
    weight: 0.15
    scoring_guidance: |
      Does this idea leave room to grow, or paint itself into a corner?

      This matters more than at `tinker` ceremony because the operator
      will likely build on it. A v1 that has to be rewritten to add v2's
      obvious-next-feature is a tax that compounds.

      Strong signals:
        - Modular at its core. Features are additive — the v2 feature
          slots in next to the v1 feature, not on top of it.
        - Data shape is forgiving — adding fields doesn't break older
          rows; new entity kinds slot into existing tables.
        - The "good v1" path and the "good v2" path are the same path.
        - Boundaries between concerns are clear (UI / data / business
          logic / external integrations are not all the same module).

      Weak signals:
        - Idea conflates many concerns; carving out a clean v1 would
          itself be a design exercise.
        - Architecture is rigid — adding the obvious next feature would
          require rewriting the core.
        - Couples to a single external service such that switching
          providers means rewriting half of it.
        - Implicitly assumes single-user / single-tenant in ways that
          would break down if the operator wanted to share it later.

      Anchors:
        - 9-10: the operator can sketch v1 → v3 without major rework.
        - 7-8: minor refactors expected at v2.
        - 5-6: v2 will need targeted rewrites of one or two modules.
        - 3-4: v2 likely means re-architecting from scratch.
        - 0-2: idea is shaped such that any v1 is a dead-end.

  - id: friction_to_start
    weight: 0.10
    scoring_guidance: |
      How quickly can the operator have a working v1 in their hands?

      Strong signals:
        - All prerequisites (data, accounts, infra) already exist.
        - The first useful version doesn't need much before it's useful
          (no bulk data import, no model training, no extensive seed
          data).

      Weak signals:
        - Requires onboarding paperwork, account creation, key setup,
          or tier upgrades on external services.
        - Useful only after significant data ingestion or training.
        - Needs hardware the operator hasn't bought.

      Anchors:
        - 9-10: working v1 within a single Factory session.
        - 7-8: v1 within a few days, mostly Factory time.
        - 5-6: v1 in a week, gated on operator setup tasks.
        - 3-4: significant operator-side prerequisites.
        - 0-2: weeks of operator setup before Factory can help.

decision_thresholds:
  greenlit: 7.0       # weighted_score >= 7.0 AND uncertainty <= 0.3
  parked_min: 4.5     # weighted_score in [4.5, 7.0) → parked
  trashed: 4.5        # weighted_score < 4.5 → trashed

decompose_when: |
  uncertainty > 0.4 — too thin to score with confidence; ask 1-3
  clarifying questions instead of guessing.

uncertainty_sources:
  - missing_axis_evidence: |
      The operator's idea text doesn't address one or more axes (e.g.
      no signal about how often they'd use it).
  - conflicting_signals: |
      Different axes pull in opposite directions strongly — the idea
      scores 9 on usefulness but 2 on agent_buildability, and the
      operator hasn't indicated which they care about more.
  - insufficient_idea_detail: |
      Idea is one or two sentences and could mean several different
      things — e.g. "build a habit tracker" without saying what makes
      it different from existing ones.

agent_invocation:
  prompt_key: triage-prompt-v1
  defaults:
    ceremony: personal
    role: owner

freeze_preconditions:
  # When this rubric's verdict produces a project, these must hold
  # before the bootstrap plan can freeze.
  feature_plan_vision_filter: required
  project_vision_plan: required
```

The other four rubrics follow the same shape with axis weights and
guidance tuned to their level. Sketch:

### `rubric-owner-tinker.yaml` (refresh of current)

Axes (weights):
- `personal_fit` (0.25), `time_to_first_value` (0.25),
  `agent_buildability` (0.25), `usefulness` (0.15), `stack_fit` (0.10).

Mental anchor: "Worth a few hours? Will I be glad I tried?" Maintenance
cost intentionally absent — tinker projects are allowed to bitrot.

### `rubric-owner-shared.yaml`

Axes (weights):
- `value_to_users` (0.25) — how much do real other people benefit?
- `support_burden` (0.20) — am I willing to answer questions, write
  docs, triage bugs from strangers?
- `quality_bar` (0.20) — does the idea force a level of polish I'm
  prepared to deliver?
- `license_clarity` (0.10) — is the license/contribution model decided?
- `agent_buildability` (0.15) — same as personal.
- `foundation_quality` (0.10) — same as personal but stricter.

Mental anchor: "Other humans will see this. Am I ready for that?"

### `rubric-owner-production.yaml`

Axes (weights):
- `problem_severity` (0.25) — real users have real pain?
- `risk_profile` (0.20) — security, data loss, downtime, regulatory.
- `support_capacity` (0.15) — am I willing to be on-call?
- `differentiation` (0.15) — does this exist already, better, free?
- `agent_buildability` (0.10).
- `foundation_quality` (0.15) — strictest.

Mental anchor: "Other humans depend on this. What breaks if I get this
wrong?"

### `rubric-contributor.yaml`

Axes (weights):
- `alignment_with_upstream` (0.30) — do maintainers actually want this?
  Is it on the roadmap, in an issue with positive maintainer reactions,
  or am I about to dump an unsolicited 2k-line PR on someone's plate?
- `reviewability` (0.20) — is the change small enough that a reviewer
  can hold it in their head? Is it scoped to one concern?
- `breaking_change_risk` (0.15) — does this require coordinating with
  downstream consumers, deprecation cycles, migration guides?
- `test_and_doc_burden` (0.15) — does the project have conventions I
  need to follow? Are the tests easy to extend?
- `agent_buildability` (0.10).
- `mergeability_evidence` (0.10) — have similar PRs landed recently?
  Is the project active? Maintainers responsive in the last 90 days?

Mental anchor: "Will this PR get merged, and is the cost of writing it
worth that probability?"

## Triage prompt update

The current `triage-prompt-v1.md` tells the agent the inputs include
`{{GOAL_HINT}}`. That changes:

```diff
- - `{{GOAL_HINT}}` — optional goal hint (one of `me`, `learn`, `share`,
-   `productize`), or `null`.
+ - `{{INTENT_CEREMONY}}` — the operator's intent at capture, one of
+   `tinker`, `personal`, `shared`, `production`, or `null`.
+ - `{{INTENT_ROLE}}` — `owner` or `contributor`, or `null`.
+ - `{{LICENSE_CONTEXT}}` — relevant license info: for `contributor` mode,
+   the upstream project's license; for `owner` `shared`/`production`,
+   the operator's stated license intent. Null otherwise.
```

The prompt also needs explicit guidance on how to weigh the rubric's
guidance vs. the agent's prior — since the new rubrics are
substantially more detailed, the agent should lean into them harder.
Add:

> Treat the rubric as authoritative. When the rubric's
> `scoring_guidance` for an axis names specific signals (e.g. "9-10
> only when operator names 3+ recent moments of need"), apply those
> anchors literally. Do not score above an anchor's threshold without
> the evidence the anchor names.
>
> When you cannot find that evidence in the idea text, score
> conservatively and either (a) raise `uncertainty` if the gap is
> bridgeable, or (b) emit `decompose` with a clarifying question that
> would surface the missing evidence.

This is the major behavioral shift. The current rubric has thin
guidance, so the agent fills gaps with its own priors. The new rubrics
constrain it.

A separate prompt — `triage-contributor-v1.md` — is needed for the
contributor flow because the inputs and decision shape differ enough
that overloading one prompt would muddy both. Specifically the
contributor prompt must:

- Take the upstream repo (or a snapshot of recent issues / PRs / commit
  log) as part of context, so `alignment_with_upstream` and
  `mergeability_evidence` axes have something to score against.
- Output a different `spec_stub` shape — the deliverable is a PR plan
  (target branch, commit list, expected diff size) not a project_spec.

## Behavior matrix

What changes downstream when each (ceremony, role) combo is in effect:

| Combo                       | project_vision plan | feature_plan vision filter | Default audits                                                              | Bootstrap behavior                          |
|-----------------------------|---------------------|----------------------------|-----------------------------------------------------------------------------|---------------------------------------------|
| owner / tinker              | not created         | skipped                    | none by default                                                             | minimal: workdir + main branch + CLAUDE.md  |
| owner / personal            | created, draft      | required                   | maintenance-fit (1)                                                         | + project_vision plan, + 1 default audit    |
| owner / shared              | created, draft      | required                   | maintenance-fit, contribution-readiness, license-check                      | + README scaffolding, + 3 default audits    |
| owner / production          | created, draft      | required                   | maintenance-fit, contribution-readiness, license-check, security, perf, ops | + full README, + 6 default audits           |
| contributor / *             | NOT created         | NOT applied                | reviewability, upstream-style-match                                         | clone upstream, branch off main, no vision  |

(1) "maintenance-fit" is a new audit skill template — checks for things
like "do I have a backup story for the data?", "are the dependencies
maintained?", "is there a clear way to retire this if I stop wanting
it?". Currently doesn't exist; would be added with this proposal.

The contributor row is the most behaviorally distinct — entire
codepaths are skipped, not just gated.

## Phasing

1. **Schema + migration + UI stub** (1 commit). Land the new columns,
   migrate existing data, update TierPicker → CeremonyPicker + add
   RolePicker chip. No behavior change yet — daemon still uses the
   current rubric for everything.
2. **Rubric authoring** (1-2 commits). Write the five rubric files with
   the verbose, anchored style demonstrated above. Update the seed
   script to seed all five. Update triage to pick the right one.
3. **Triage prompt refresh** (1 commit). New `triage-prompt-v1.md`
   honoring INTENT_CEREMONY/INTENT_ROLE; new
   `triage-contributor-v1.md`. Bump prompt version to v2.
4. **Contributor codepath** (1-2 commits). `runProjectBootstrap` skips
   `project_vision` creation when `role=contributor`; the feature_plan
   vision filter early-returns; clone-from-upstream becomes the
   bootstrap path.
5. **Audit defaults per combo** (1 commit). Audit skill installation
   logic reads (ceremony, role) and installs the right default set.
6. **License field plumbing** (1 commit). Read from `package.json` /
   `LICENSE` on adoption. Surface in project header. Drive license-check
   audit.

Each phase is independently shippable. A release tag at the end of
phase 2 means the live daemon's triage gets meaningfully better even
before the contributor codepath lands.

## Open questions

1. **Should `intentCeremony` / `intentRole` move to `ideas` or live on
   the operator-default level?** Today's `goalHint` is per-idea. If
   most ideas come from a phone capture without an explicit intent,
   per-idea intent rarely gets set. An operator-default that lives in
   settings might be the right ergonomics. Probably: support both,
   default to operator-default when per-idea is null.
2. **Does the contributor rubric need access to upstream's existing
   docs/issues at triage time?** If yes, the triage flow has to fetch
   them, which is a meaningful expansion of what triage does today
   (currently triage is offline-only). Could start with operator-pasted
   context as input and add fetch later.
3. **Are five rubrics the right granularity, or should we collapse some?**
   Owner-tinker and owner-personal are genuinely different. Shared and
   production are also genuinely different. But shared-vs-production
   could plausibly be one rubric with a `severity_multiplier` knob.
   Lean toward five separate rubrics for clarity; revisit if maintenance
   becomes a chore.
4. **License: just SPDX text, or structured?** Lean toward SPDX text
   stored as-is (matches what `package.json`'s `license` field looks
   like). Audit skills can pattern-match.
5. **Should "open source" derive from license or be its own flag?**
   Probably derive: `license` matching SPDX OSS list = OSS. Reduces
   one configuration surface.

## What this isn't

- A way to run multi-operator workflows. Factory remains
  single-operator. `contributor` mode just changes which operator
  permissions / vision-setting privileges the agent assumes.
- A way to enforce code-review or approval gates. The vision filter is
  the closest thing, and it's narrow (feature plans only, freeze-time
  only).
- A path to rich permission / RBAC. If shared/production projects need
  per-collaborator permissions later, that's a separate primitive.
