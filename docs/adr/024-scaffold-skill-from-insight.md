# ADR-024 — Scaffold a reusable skill from a Watch insight

**Status:** accepted · **Date:** 2026-07-03 · Extends ADR-010 (The Watch).

## Context

The Watch (ADR-010) synthesizes insights from the operator's out-of-band work and surfaces
them as `watch_insight` decisions. Each carries a `proposal` — `adopt-as-task`,
`draft-feature-plan`, `groom-backlog`, `record-as-convention`, or `note-only`. Three of those
require a `projectId`; a **project-less** insight (no `targetProjectSlug`) that lands as
`note-only` — the residual bucket — has **no actionable outcome**. The operator can only
`acknowledge` or `dismiss` it.

But the highest-value project-less insights are exactly the ones worth acting on: "you keep
hand-porting the upgrade/install machinery into every new tool — generalize it." The operator
wants to say *"good idea, let's make this a reusable skill,"* and have that produce real work.

A skill also shouldn't be locked to one harness. The `npx skills` ecosystem
([vercel-labs/skills](https://github.com/vercel-labs/skills)) made GitHub the registry: any
repo with a `SKILL.md` (YAML frontmatter + markdown) is a valid source, installable into
Claude Code, Codex, Cursor, OpenCode, etc. via `npx skills add <repo> --skill <name>`.

## Decision

Add a **`scaffold_skill`** action to the `watch_insight` resolve path. It is valid regardless
of the insight's proposal or project — the whole point is to give a project-less insight an
actionable outcome.

1. **A designated skills-registry project.** A new `skills-project-id` setting names the
   Factory project whose repo is an `npx skills`-compatible registry (`skills/<name>/SKILL.md`).
   Set once in Settings. The canonical repo is [`rnwolfe/skills`](https://github.com/rnwolfe/skills).

2. **The action files a skill-authoring task there.** `scaffold_skill` derives a skill brief
   from the insight (the ritual, its provenance, the operator's optional directive) and
   `createTask`s it on the skills project. A normal Factory run then authors the `SKILL.md` —
   harness-agnostic by construction — and auto-merges per v0.1. The insight's observation is
   marked `adopted`. If no skills project is designated, the action returns a precondition
   error prompting the operator to set one.

3. **Harness-agnostic output.** The brief (and the registry's `AGENTS.md`) require the authored
   skill to avoid harness-specific tools/paths, so one `SKILL.md` installs everywhere via
   `npx skills`.

## Consequences

- A project-less `note-only` insight is no longer a dead end; it can become a reusable,
  cross-harness skill with one tap + an optional directive.
- The skill is realized through the normal project-scoped run pipeline (no writing to
  `~/.claude/skills` from a sandboxed run) — fully in-architecture.
- **Rejected:** writing the skill directly into the operator's global config (out of the
  sandbox model); a bespoke per-invocation project picker (a single designated registry is
  simpler and matches "no second attention sink"). **Deferred:** exposing `scaffold_skill` on
  the full `/decisions/:id` route (it lives on the inbox detail pane today) and auto-`npx
  skills add`-ing the result back onto the host.
