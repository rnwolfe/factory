# factory — Vision

> Authored by Factory plan `#gg4566sw`. Edits welcome — this
> is a checked-in document like any other.

## Identity

Factory is a single-operator software studio: a Bun daemon plus a phone-first PWA, run on a server you own, that turns a stream of ideas into a portfolio of running codebases meant to be shipped — shared, productized, or shown publicly, not kept as throwaway tinkering. A worker pool drives up to N agent sessions concurrently across every project, with the agents doing the toil under loose human supervision. The operator's only must-respond surface is the decisions inbox; everything else is read-only or one-tap.

## Audience

One technical operator building a portfolio of share-, production-, and public-grade projects at once — who wants to make the judgment calls and have agents do the work, not babysit a single chat in a single repo.

## Problem

Most 'AI coding' tools optimize a single chat in a single repo, but a serious portfolio is plural — many projects, many threads, many runs in flight, each held to a share/production bar — so the operator drowns in context-switching and babysitting. Factory collapses the attention surface to one inbox, pushes the friction onto the agent's side, and keeps each project honest enough to ship.

## Design principles

- **Plural over singular.** Many projects in flight beats one perfected repo; concurrent agent sessions across all projects are the point, not an edge case.
- **Ship-grade over throwaway.** Projects are built to a share/production bar, not as prototypes — agents apply real rigor (vision filter, audits, conventions, honest completion), and tier decides how much ceremony each one earns rather than whether quality matters at all.
- **One attention sink.** The decisions inbox is the sole must-respond surface; any new notification stream has to justify why it isn't just the inbox.
- **Phone-first over desktop-first.** Every screen works at 390px before it earns desktop polish — capture an idea in 10 seconds from a train, approve a decision from the bus.
- **Honest completion over optimistic.** A run that can't emit a structured factory-status declaration is marked failed, never silently completed with no diff.
- **Informational over gating.** Quality checks and audits inform the operator; they never block a merge, because the operator owns the ship call, not a CI gate.

## Out of scope

- No second inbox — operational dashboards and activity feeds stay read-only; we keep resisting the urge to add another must-respond surface beside the decisions inbox.
- No bug tracker of our own — once GitHub Issues backs a project, the issue IS the task; we index issues, we don't reimplement them (beads/GitHub are already better at this).
- No hosted multi-tenant SaaS — Factory itself runs on a server you own for one operator; org management, billing, and shared-team auth are deliberately absent, even though the projects it produces ship to the world.
- No quality/audit merge gate — checks and audits are signal, not a veto; gating would move the ship call away from the operator.
- No interactive permission prompts on runs — the per-run worktree is the isolation boundary, not CLI permission gates; runs stay non-interactive.
- No desktop-first redesign — the Vercel-style chrome layers over the phone-first PWA; the 390px mobile invariant is never sacrificed for desktop density.

## Personality

Dispatcher's-console: warm-dark #0a0908, amber accent, Fraunces / Geist / Geist Mono, dense rows, chips not pills, no shadcn defaults. Copy is terse and honest — the UI states what's running, not what might be nice.

## Roadmap

### shipped (v0.1–v0.4)

- Path A: capture → triage → decision → plan → bootstrap → runs, with honest factory-status completion and auto-merge to main
- Plan primitive as first-class + informational quality signal (v0.2)
- Audit primitive, Path-B continuous execution, tier-aware onboarding (v0.3)
- Audit cadence — a schedule layer over the audit primitive (v0.4)

### now

- GitHub Issue backend as the task store — the issue is the task; comment threads fold into the run prompt and write back on completion
- Two-way operator↔Factory decision dialog for blocked runs / agent decisions, mirrored to GitHub issues
- Spec-sourced milestone decomposition (ADR-009)

### near

- Desktop Vercel-style chrome layered over the phone-first PWA; Tauri wrapper
- A complementary operational-awareness layer that doesn't become a second inbox
- Codex harness parity gaps closed where feasible (cost reporting, thread resume hints)

### later

- A real sandbox to retire --dangerously-skip-permissions on code-changing runs
- Auto-rollback on failed upgrade
- Remote/pluggable artifact storage behind the existing repo-canonical seams

## Prior art

- Claude Code / Codex CLI — the single-repo agent harnesses Factory drives; Factory is the multi-project orchestration layer they lack.
- GitHub Issues — not a competitor to integrate around but the task backend itself; reacting against building our own tracker, we make the issue the task.
- forge's /product skill — its four-test vision filter (identity / principle / phase / replacement) is lifted directly to keep scope creep out of share- and production-tier projects.
- beads — better at issue tracking than we'd be; the explicit reason Factory refuses to build its own bug tracker.
- Vercel dashboard — the source for the desktop chrome aesthetic and the 'read-mostly, one deliberate action' surface model.
