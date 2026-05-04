CREATE TABLE `plan_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`resulting_draft` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plan_comments_plan_created_idx` ON `plan_comments` (`plan_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'drafting' NOT NULL,
	`decision_id` text,
	`project_id` text,
	`task_id` text,
	`goal` text NOT NULL,
	`draft` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`frozen_at` integer,
	`abandoned_at` integer,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plans_status_created_idx` ON `plans` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `plans_project_kind_idx` ON `plans` (`project_id`,`kind`);--> statement-breakpoint
ALTER TABLE `runs` ADD `task_plan_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `quality_report` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `acceptance_results` text;