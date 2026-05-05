CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`mode` text DEFAULT 'claude' NOT NULL,
	`description` text,
	`branch_name` text NOT NULL,
	`worktree_path` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`commit_count` integer DEFAULT 0 NOT NULL,
	`merged_at` integer,
	`merge_error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_project_started_idx` ON `sessions` (`project_id`,`started_at`);