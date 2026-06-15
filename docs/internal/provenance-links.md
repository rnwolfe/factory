# Provenance Links Inventory

Factory shows a source link only when the payload carries a destination that can
be used without guessing. The shared PWA source-link renderer accepts only
root-relative Factory routes and HTTPS URLs; GitHub issue links are further
restricted to `https://github.com/<owner>/<repo>/issues/<number>` matching the
payload issue number when one is present.

## Linked now

- `issue_intake` decisions link to the originating GitHub issue only when the
  webhook payload stored GitHub's `html_url` as `payload.htmlUrl`. Older payloads
  that lack `htmlUrl` render the issue number/title as plain text.
- GitHub-backed tasks link to their issue when `TaskFile.filePath` has the
  `github:<owner>/<repo>#<number>` shape emitted by `GithubIssuesStore`.
- Plan-, audit-, and finding-origin task links use Factory-internal routes
  derived from task frontmatter (`sourcePlanId`, `sourceAuditId`,
  `sourceFindingIds`).

## Deferred follow-ups

- Backfill existing `issue_intake` decisions that predate `payload.htmlUrl`.
  Those rows have issue number/title/author but no canonical repository URL in
  the decision payload, so deriving a GitHub URL in the UI would be a guess.
- Add source links to `blocked_run` and `merge_failure` inbox cards. Their
  payloads carry `runId`/`taskId`, but not all historical rows have enough
  project context in the payload itself; link generation should be backed by a
  router shape that joins the source run/task safely.
- Add source links to release-proposal decisions once the proposal records the
  exact commit range or tag comparison URL. Current payloads contain rendered
  release text and target version, not a trustworthy source URL.
