CREATE TABLE `audits` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_version` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`reviewed_at` integer,
	`approved_at` integer,
	`rejected_at` integer,
	`report_markdown` text,
	`findings` text,
	`approved_report_path` text,
	`claude_session_id` text,
	`prompt_version` text,
	`worktree_path` text,
	`tmux_session_name` text,
	`pane_log_path` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audits_project_status_idx` ON `audits` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `audits_status_started_idx` ON `audits` (`status`,`started_at`);--> statement-breakpoint
ALTER TABLE `plans` ADD `tier` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `superseded_by` text;