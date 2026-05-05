CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`vote` text NOT NULL,
	`body` text NOT NULL,
	`context_route` text,
	`context_hint` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_target` text,
	`claude_session_id` text
);
--> statement-breakpoint
CREATE INDEX `feedback_status_created_idx` ON `feedback` (`status`,`created_at`);