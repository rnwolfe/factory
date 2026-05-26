-- Rename the session mode `claude` → `claude-code` to match the canonical
-- agent id used throughout the codebase. The agent registry uses
-- `claude-code` (not `claude`) as the AgentName for the Anthropic harness,
-- and the new sessionModeEnum is `shell | claude-code | codex` so session
-- modes line up 1:1 with registered agents.
--
-- Sessions are short-lived and rarely consulted after they end; the mode
-- field is mainly used at session-start to pick the launch command. This
-- rename keeps the field meaningful for any tooling that does inspect
-- ended sessions retrospectively.

UPDATE `sessions` SET `mode` = 'claude-code' WHERE `mode` = 'claude';
