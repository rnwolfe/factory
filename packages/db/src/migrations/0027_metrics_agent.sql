-- Per-harness aggregation column on the metrics table. Adding `agent`
-- (claude-code | codex | ...) lets the metrics router groupBy="agent" be a
-- direct column read instead of a fragile model-id-prefix inference at
-- query time. Future harnesses register a descriptor and start recording
-- under their canonical id; no query-side CASE expressions to maintain.
--
-- The backfill clause maps every existing row's `model` value onto a
-- best-effort agent id:
--   claude-* / opus-* / sonnet-* / haiku-*   → claude-code
--   gpt-* / codex-*                          → codex
--   anything else (null model, etc.)         → null
--
-- The table keeps the legacy name `claude_metrics` (the daemon's record
-- helper is `recordAgentMetrics` after this change but the storage stays
-- where it is — operators with rows in this table don't care what we call
-- it from TS-land).

ALTER TABLE `claude_metrics` ADD `agent` text;

UPDATE `claude_metrics` SET `agent` = 'claude-code'
WHERE `agent` IS NULL
  AND (`model` LIKE 'claude-%' OR `model` LIKE 'opus-%' OR `model` LIKE 'sonnet-%' OR `model` LIKE 'haiku-%');

UPDATE `claude_metrics` SET `agent` = 'codex'
WHERE `agent` IS NULL
  AND (`model` LIKE 'gpt-%' OR `model` LIKE 'codex-%');

-- Composite index for the dominant query shape: "metrics for project P
-- bucketed per agent over a time range". Without this the per-agent groupBy
-- falls back to a full scan filtered on createdAt then projectId then agent.
CREATE INDEX `claude_metrics_agent_created_idx` ON `claude_metrics` (`agent`, `created_at`);
