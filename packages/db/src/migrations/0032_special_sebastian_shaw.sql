ALTER TABLE `interventions` ADD `type` text DEFAULT 'worktree_repair' NOT NULL;--> statement-breakpoint
ALTER TABLE `interventions` ADD `blocker_questions` text;--> statement-breakpoint
ALTER TABLE `interventions` ADD `operator_reply` text;--> statement-breakpoint
ALTER TABLE `interventions` ADD `retry_run_id` text;--> statement-breakpoint
ALTER TABLE `interventions` ADD `outcome` text;--> statement-breakpoint
CREATE INDEX `interventions_source_run_idx` ON `interventions` (`source_run_id`);
