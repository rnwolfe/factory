---
name: release
description: Cut a Factory release — version bump, changelog, annotated tag, push instructions.
kind: operator
needs_worktree: false
---

# release

Cut a new release of Factory. The release is a tagged sha on `main` that
the `factory upgrade --channel=stable` resolver picks up. The Factory
daemon running on the operator's host can then upgrade to it.

You can run this skill from the dev checkout. The operator pushes the
result to GitHub manually at the end.

## Preconditions

Before doing anything else, verify:

1. You're on `main` (`git rev-parse --abbrev-ref HEAD` returns `main`).
   If not — stop. Surface the situation; the operator may want to merge
   first.
2. The working tree is clean (`git status --porcelain` is empty). If
   not — stop and surface.
3. `git fetch origin` succeeds and `main` is up-to-date with
   `origin/main` (or, equivalently, `git log origin/main..HEAD` is
   empty). If not — stop and surface.
4. `bun run typecheck && bun run check && bun test` all pass on the
   current sha. If not — stop and surface.

If any precondition fails, do **not** proceed silently. The operator
needs to know what's blocking.

## Step 1 — Determine the version bump

Find the most recent release tag:

```sh
git describe --tags --abbrev=0 --match 'v*.*.*'
```

If the command exits non-zero, this is the first release — start at
`v0.1.0`.

Otherwise, list every commit since that tag:

```sh
git log <last-tag>..HEAD --pretty=format:'%h %s'
```

Categorize each subject by conventional-commit prefix:

- `feat:`, `feat(scope):` → minor bump (or major if it's clearly
  breaking — check the body for `BREAKING CHANGE:`)
- `fix:`, `fix(scope):` → patch bump
- `refactor:`, `chore:`, `docs:`, `test:` → patch bump
- Anything with `BREAKING CHANGE` in the body, or a `!` after the type
  (`feat!:`) → major bump

Pick the largest bump implied by any commit. **Surface your
reasoning to the operator before bumping** — the bump is a judgment
call, not an automatic transformation. Phrase it as: "I see <N>
commits, of which <M> are feat, <K> are fix; I'd recommend a <minor>
bump from <prev> to <new>. Confirm?"

If the operator pushes back, re-evaluate. Don't argue — they have
context you don't.

## Step 2 — Write the changelog entry

Append a new section to `CHANGELOG.md` at the repo root (create the
file if absent — see "First-time changelog" below). Format:

```markdown
## v<NEW_VERSION> — <YYYY-MM-DD>

### Added
- <bullet for each `feat:` subject — strip the prefix; capitalize first letter; trailing period>

### Changed
- <bullet for `refactor:` and `chore:` that materially affect behavior or operator-visible surface>

### Fixed
- <bullet for each `fix:` subject>
```

Skip empty sections. Skip `docs:` and `test:` unless they're material
(e.g. user-facing docs gain a new section worth flagging). Group by
section, then within each section preserve commit order (chronological).

For the first changelog entry, also add the file header:

```markdown
# Changelog

All notable changes to Factory are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

```

## Step 3 — Bump the version

Update `package.json` at the repo root: `"version": "<NEW_VERSION>"`.

The workspace packages under `apps/*` and `packages/*` carry their own
`version` fields. By default, **bump the workspaces in lockstep** —
they ship together; independent versioning would just be drift.

If the operator wants workspaces pinned independently, they'll say so
— don't ask preemptively.

## Step 4 — Commit

```sh
git add CHANGELOG.md package.json apps/*/package.json packages/*/package.json
git commit -m "chore(release): v<NEW_VERSION>"
```

Single commit, no co-author trailer (this is a release commit, not
substantive work).

## Step 5 — Tag

Annotated tag with the changelog entry as the message body:

```sh
git tag -a v<NEW_VERSION> -m "v<NEW_VERSION>

<paste the changelog entry body here, sections and bullets>"
```

Annotated (not lightweight) so the tag carries attribution and a
date — `factory upgrade --channel=stable` doesn't care, but `git
describe` and downstream tooling do.

## Step 6 — Hand off to the operator

Print the push commands. **Do not run them yourself.** Pushing tags
to a shared remote is an operator-authorized action.

```
release ready:
  git push origin main
  git push origin v<NEW_VERSION>

after push:
  factory upgrade        # if you want to upgrade the live daemon now
  factory channel resolve  # to confirm the new tag is the resolver target
```

## First-time changelog

If `CHANGELOG.md` doesn't exist yet, the first run of this skill
should backfill from the existing tag history:

```sh
git tag -l 'v*.*.*' --sort=-version:refname
```

For each prior tag (oldest first), add a section with the commits
between it and its predecessor. Best-effort — don't spend more than a
few minutes on backfill; the goal is "we have a history starting
now," not "we have a perfectly groomed retroactive changelog."

## Failure modes

- **Precondition fails:** stop, surface, do not proceed.
- **Operator declines the proposed bump:** re-evaluate with their
  feedback; do not push back.
- **Test or typecheck breaks during the run:** abort, surface — they
  shouldn't have broken if step 0 passed; investigate before retrying.
- **`git tag` fails because the tag already exists:** surface
  immediately — never `--force` an existing release tag.
