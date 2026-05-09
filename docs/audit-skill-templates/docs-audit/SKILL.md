---
name: docs-audit
description: Check project doctrine (VISION.md, CLAUDE.md, README.md) for staleness, contradictions, and missing entries warranted by recent merged work.
kind: read-only
needs_worktree: false
default_severity_grade: enabled
---

# docs-audit

You are auditing the project's doctrine documents. Your goal is to keep
project doctrine **honest and current** — surface places where the docs
have drifted from the code, contradict themselves, or are missing entries
that recent merged work warrants.

## Scope

Read these files, when present:

- `docs/internal/VISION.md` — the project's identity / principles / phases
- `CLAUDE.md` — the agent's operating manual
- `README.md` — the operator-facing entry point
- `docs/internal/audits/` — prior approved audit reports (skim titles)

You also have access to the project context Factory provides
(recent commits, code structure if needed).

## What to look for

1. **Stale references.** A doc names a file, function, or contract that
   doesn't exist in the code anymore. Pin it.
2. **Contradictions.** VISION.md says X is out-of-scope; CLAUDE.md or
   recent code shows X being built. Or two design principles in VISION.md
   contradict each other.
3. **Missing entries warranted by merged work.** A new architectural
   contract emerged in a recent commit (e.g., a "do not bypass this
   wrapper" pattern) but CLAUDE.md doesn't mention it. Or a new external
   dependency / config knob landed but README is silent.
4. **Stale audit references.** Approved audit reports referenced from
   CLAUDE.md whose subjects have since been resolved or rewritten.

## Report shape

The audit framework's two-block envelope handles the report shape: the
`factory-audit-report` fence carries operator-readable text, and the
`findings` JSON carries the structured array.

Inside the report fence, walk per-doc:

- A `## Summary` section: one paragraph naming the docs you read and
  the headline result.
- One `## VISION.md`, `## CLAUDE.md`, `## README.md`, etc. section per
  doc you reviewed. State what you read and what you flagged for that
  doc (or "current" if nothing).
- A `## Findings` section that lists every flag with `### <severity>:
  <title>` and pinned references where applicable.

Severity guide for this skill (the framework's general guide applies; this
narrows it):

- **major**: contradiction or stale-on-current-code reference
- **minor**: outdated detail, missing minor entry
- **enhancement**: doc could be sharper but isn't wrong

If everything is current, emit `"findings": []` and say so honestly in
the report.

## Procedure

You're read-only — no shell. Use the project context the prompt provides
plus your own model of the project from VISION/CLAUDE/README.

The output contract footer is added automatically.
