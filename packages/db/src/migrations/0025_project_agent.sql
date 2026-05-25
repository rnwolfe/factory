-- Per-project headless agent selection. Sits between task.frontmatter.agent
-- and settings.default-agent in the inheritance chain:
--   submit input  →  task.frontmatter.agent  →  projects.agent  →
--     settings.default-agent  →  "claude-code"
--
-- Pairs with the existing `projects.model` column to form a fused
-- `{agent, model}` shape that the PWA picker exposes as one control. The
-- model string is interpreted by whichever provider the agent names —
-- `claude-code` reads claude model ids; `codex` reads codex model ids.
--
-- Existing rows are explicitly pinned to `claude-code` (the only agent
-- before this column existed) so the picker shows a concrete selection
-- rather than an indeterminate "inheriting" state.

ALTER TABLE `projects` ADD `agent` text;
UPDATE `projects` SET `agent` = 'claude-code' WHERE `agent` IS NULL;
