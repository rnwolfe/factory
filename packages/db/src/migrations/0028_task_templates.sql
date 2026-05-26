-- Cross-project task templates. Frozen `task_template` plans persist into
-- this table; the templates picker on the project page lets operators
-- instantiate any of them against the current project to produce a real
-- task file in `.factory/work/`.
--
-- Templates are Factory-canonical (not repo-canonical) — they sit
-- alongside rubrics and prompts in the "lives in the daemon DB, shared
-- across all projects" set rather than the "per-project artifact" set.
--
-- `draft` is the JSON-serialized `TaskTemplateDraft` from packages/db's
-- type union. Schema is intentionally loose (TEXT) so future template
-- shape changes are migration-free; consumers do their own zod coercion
-- on read.

CREATE TABLE `task_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `draft` text NOT NULL,
  `source_plan_id` text,
  `archived_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE UNIQUE INDEX `task_templates_slug_uniq` ON `task_templates` (`slug`);
CREATE INDEX `task_templates_archived_idx` ON `task_templates` (`archived_at`);
