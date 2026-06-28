CREATE TABLE `metrics_daily` (
	`date` text NOT NULL,
	`project_id` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_daily_uniq` ON `metrics_daily` (`date`,`project_id`,`metric`);--> statement-breakpoint
CREATE INDEX `metrics_daily_metric_idx` ON `metrics_daily` (`metric`);