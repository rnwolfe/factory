ALTER TABLE `projects` ADD `auto_advance` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `blocker_questions` text;