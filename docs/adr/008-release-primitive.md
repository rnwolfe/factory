# ADR-008 · Release as a templated function — model-resolved variables + inbox confirmation

**Status:** proposed (2026-06-14)
**Scope:** post-v0.22
**Builds on:** the task-template mechanism (`task_templates` table,
`apps/daemon/src/task-templates/instantiate.ts`). This is **not** a new
primitive — it is two small extensions to templates, applied to the existing
`release-project` template.

## Context

Release already exists as the **`release-project` task template** in the DB —
the dynamic, templated function the operator instantiates against a project. Its
first `variable` is `version` (`required: true`, no default), so instantiation
**prompts the operator for the version number**, then renders the template's
sections (static substitution + `claude --print` for `agent`-kind sections) and
`createTask`s a real task in `.factory/work/` that subsequently runs to do the
bump / changelog / tag.

Two frictions, both narrow:

- **The version is asked, not derived.** `version` is a fact the model can
  compute from the commit set since the last tag under the project's versioning
  scheme. Making it a required operator variable is ceremony.
- **The release isn't confirmed as prose; it's emitted as a task.** Instantiation
  silently produces a task that then runs (and, with auto-advance, can fire
  without a second look). Every other operator judgment call flows through the
  inbox as a thing-to-confirm. Release should land as a **prose proposal**
  (resolved version + "what's new") the operator confirms, not as a task that
  has already left the gate.

The earlier draft of this ADR proposed a parallel "release primitive." That was
wrong: the substrate (templates) already *is* the dynamic templated function.
The fix is to make templates a little smarter, not to clone them.

## Decision

### 1. Model-resolved template variables (general)

Extend `TaskTemplateVariable` (schema.ts) with an optional resolver:

```ts
interface TaskTemplateVariable {
  key: string;
  label: string;
  description: string;
  required: boolean;
  default: string | null;
  // NEW — absent ⇒ { kind: "operator" } (today's behavior, fully back-compat).
  resolver?:
    | { kind: "operator" }            // prompt the operator (current default)
    | { kind: "agent"; prompt: string }; // model computes it at instantiation
}
```

In `resolveVariables` / `instantiateTaskTemplate`, an `agent`-resolved variable
is **not** prompted. Instead it's filled by one `claude --print` pass over the
already-gathered project context (`gatherProjectContext`: AGENTS.md, README,
recent commits — extended with `git log <last-tag>..HEAD` and the versioning
scheme) using the variable's `resolver.prompt`. This is a general capability —
any template can now derive a variable from repo state — but its first use is:

> `release-project.version` → `{ kind: "agent", prompt: "Determine the next
> version from commits since the last v*.*.* tag under the project's versioning
> scheme (semver-from-conventional-commits unless the project says otherwise).
> Return only the version string, e.g. v0.23.0." }`

So the operator is never asked for a number; the resolved value is shown back in
the proposal (and editable there).

### 2. Release proposal lands in the inbox for confirmation

A template (opt-in via a draft flag, e.g. `confirmInInbox: true`, set on
`release-project`) does not create an auto-advancing task on instantiation.
Instead it lands a **`release_proposal`** decision (new `decisionKindEnum`
member — the same one-line addition `issue_intake` made) carrying the resolved
`version`, the rendered "what's new" prose (reusing the `ChangelogEntry` shape
from `changelog.ts`, so it renders like the post-upgrade release-notes sheet),
and the would-be task body.

```
instantiate (version resolved by model, prose rendered)
        │
        ▼
  release_proposal decision in inbox  ──dismiss──▶ discarded
        │
     confirm (operator may edit version / notes)
        ▼
  execute: create the release task → run does bump/changelog/tag
        │            (existing run path; no new executor)
        ▼
  push per the project's distribution config
```

**Confirm is the authorization boundary.** The inbox confirm *is* the explicit
per-release operator authorization, so the standing "don't push tags unprompted"
rule is satisfied — confirm may push (default for projects with a channel).
Upgrading the live daemon stays a separate one-tap action so a release and a
prod restart aren't welded together.

### "What's new" source (v1)

Synthesize from history — commits since the last tag + task titles + run
summaries — exactly the filter the current template's `Recipe` section already
describes ("operator-visible only"). No new per-task brief field in v1; a clean
seam is left to seed/override from per-task briefs later.

## Schema / surface

- `TaskTemplateVariable.resolver?` (optional; back-compat — absent = operator).
- `TaskTemplateDraft.confirmInInbox?` (optional; opt-in confirmation behavior).
- `decisionKindEnum += "release_proposal"`.
- No new table: the decision row is the proposal; the released tag is the
  durable record (repo-canonical per CLAUDE.md).

## Where things change

- `packages/db/src/schema.ts` — variable resolver + draft flag + decision kind.
- `apps/daemon/src/task-templates/instantiate.ts` — resolve `agent` variables;
  when `confirmInInbox`, emit a `release_proposal` decision instead of a task.
- `apps/daemon/src/routers/decisions.ts` — confirm branch for `release_proposal`
  → create the release task / run (mirror of the `issue_intake` → adopt branch).
- PWA — a `release_proposal` decision card + detail (editable version + prose),
  reusing changelog rendering.
- The `release-project` template draft — `version` → agent-resolved;
  `confirmInInbox: true`. (Data change, shipped via `packages/db/src/seed.ts`.)

## Defaults chosen (reversible)

1. Resolver absent ⇒ operator (zero behavior change for every existing template).
2. Confirm pushes (inbox confirm = authorization); upgrade stays separate.
3. Synthesize "what's new" from history; no per-task brief field in v1.
4. No new table; reuse decisions + the existing release run path.

## Consequences

- The version stops being an operator input; release joins the inbox as a
  confirm-shaped decision like everything else.
- Model-resolved variables are a reusable template capability beyond release
  (e.g. a "next milestone" or "target file" a future template could derive).
- Cost is small and substrate-shaped: a variable field, a draft flag, a decision
  kind, instantiation branching, a PWA card. No new primitive, no new executor.
- Open: auto-firing the proposal on a coherent commit-batch (a release cadence,
  à la ADR-004) vs staying operator-triggered. v1 is operator-triggered.
