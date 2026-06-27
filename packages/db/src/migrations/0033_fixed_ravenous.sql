CREATE TABLE `watch_cursors` (
	`source_id` text PRIMARY KEY NOT NULL,
	`position` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watch_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`evidence` text NOT NULL,
	`proposal` text NOT NULL,
	`target_project_slug` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_observations_dedupe_uniq` ON `watch_observations` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `watch_observations_status_idx` ON `watch_observations` (`status`);