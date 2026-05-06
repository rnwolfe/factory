-- Replace `goal` + `tier` (overlapping enums) with orthogonal axes:
-- `ceremony` (tinker/personal/shared/production) and `role` (owner/contributor).
-- `license` carries SPDX info as project metadata.
--
-- Forward-only. All existing rows are owner-mode; ceremony backfills
-- from tier with the obvious renames (share→shared, productize→production).

-- projects: add new columns
ALTER TABLE `projects` ADD `ceremony` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `role` text NOT NULL DEFAULT 'owner';--> statement-breakpoint
ALTER TABLE `projects` ADD `license` text;--> statement-breakpoint

-- projects: backfill ceremony from tier
UPDATE `projects` SET `ceremony` = CASE `tier`
  WHEN 'tinker' THEN 'tinker'
  WHEN 'personal' THEN 'personal'
  WHEN 'share' THEN 'shared'
  WHEN 'productize' THEN 'production'
  ELSE 'tinker'
END;--> statement-breakpoint

-- projects: drop legacy columns
ALTER TABLE `projects` DROP COLUMN `tier`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `goal`;--> statement-breakpoint

-- plans: add ceremony, backfill from tier, drop tier
ALTER TABLE `plans` ADD `ceremony` text;--> statement-breakpoint
UPDATE `plans` SET `ceremony` = CASE `tier`
  WHEN 'tinker' THEN 'tinker'
  WHEN 'personal' THEN 'personal'
  WHEN 'share' THEN 'shared'
  WHEN 'productize' THEN 'production'
END;--> statement-breakpoint
ALTER TABLE `plans` DROP COLUMN `tier`;--> statement-breakpoint

-- ideas: rename goal_hint to structured intent_ceremony + intent_role
ALTER TABLE `ideas` ADD `intent_ceremony` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `intent_role` text;--> statement-breakpoint
UPDATE `ideas` SET `intent_ceremony` = CASE `goal_hint`
  WHEN 'me' THEN 'personal'
  WHEN 'learn' THEN 'tinker'
  WHEN 'share' THEN 'shared'
  WHEN 'productize' THEN 'production'
END;--> statement-breakpoint
UPDATE `ideas` SET `intent_role` = 'owner' WHERE `goal_hint` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `ideas` DROP COLUMN `goal_hint`;
