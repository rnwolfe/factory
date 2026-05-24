-- Per-run effective Claude model id, resolved at submit time per the
-- inheritance chain: task frontmatter (model:) → project default
-- (projects.model) → system default (`default-model` setting) → null
-- (CLI picks). Stored so resume/retry paths and metrics views can show
-- what the run was actually invoked with, independent of any later
-- changes to the upstream values.

ALTER TABLE `runs` ADD `model` text;
