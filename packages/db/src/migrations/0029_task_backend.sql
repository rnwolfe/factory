-- ADR-007 — GitHub Issues as a per-project task backend. `task_backend`
-- selects the store: `file` (default — .factory/work/*.md) or `github-issues`
-- (GitHub Issues are canonical). `github_installation_id` caches the Factory
-- App's installation id for the project's repo so the store doesn't re-resolve
-- it on every call. Existing rows default to `file`; behavior is unchanged
-- until a project explicitly opts in.

ALTER TABLE `projects` ADD `task_backend` text DEFAULT 'file' NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` ADD `github_installation_id` integer;
