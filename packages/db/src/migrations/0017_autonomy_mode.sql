-- Add `autonomy_mode` to projects. Controls whether agent runs surface
-- mid-flight architectural decisions to the inbox (`collaborative`) or
-- pick a defensible path silently and note it in the run summary
-- (`autonomous`). Default is `collaborative` for new projects; existing
-- projects backfill based on ceremony — `tinker` defaults to autonomous,
-- everything else collaborative.

ALTER TABLE `projects` ADD `autonomy_mode` text NOT NULL DEFAULT 'collaborative';--> statement-breakpoint

UPDATE `projects` SET `autonomy_mode` = CASE `ceremony`
  WHEN 'tinker' THEN 'autonomous'
  ELSE 'collaborative'
END;
