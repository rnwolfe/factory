CREATE TABLE `claude_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text,
	`model` text,
	`model_usage` text,
	`total_cost_usd` real NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_creation_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`duration_api_ms` integer NOT NULL,
	`num_turns` integer NOT NULL,
	`session_id` text,
	`is_error` integer DEFAULT false NOT NULL,
	`subtype` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claude_metrics_owner_idx` ON `claude_metrics` (`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE INDEX `claude_metrics_project_created_idx` ON `claude_metrics` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `claude_metrics_created_idx` ON `claude_metrics` (`created_at`);