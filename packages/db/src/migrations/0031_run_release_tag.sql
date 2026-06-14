-- ADR-008 — release-as-templated-function. `release_tag` marks a run as
-- executing a confirmed release proposal and carries the annotated tag it is
-- expected to create (e.g. `v0.23.0`). After the run's branch merges into the
-- project's `main`, the runner pushes `main` + this tag to origin from the
-- project checkout (a release run's worktree has a stale `main`). Null for
-- ordinary runs, which never push.

ALTER TABLE `runs` ADD `release_tag` text;
