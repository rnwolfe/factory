CREATE TABLE `autonomy_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`run_id` text,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `autonomy_events_created_idx` ON `autonomy_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `autonomy_events_project_idx` ON `autonomy_events` (`project_id`);