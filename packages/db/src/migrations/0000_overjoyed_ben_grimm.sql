CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`idea_id` text,
	`project_id` text,
	`rubric_version_id` text,
	`outcome` text NOT NULL,
	`payload` text NOT NULL,
	`uncertainty` real,
	`weighted_score` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`actioned_at` integer,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rubric_version_id`) REFERENCES `rubric_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_text` text NOT NULL,
	`goal_hint` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`triaged_at` integer
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`idea_id` text,
	`goal` text NOT NULL,
	`tier` text NOT NULL,
	`tag` text DEFAULT 'active' NOT NULL,
	`workdir_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_key` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_key_version_uniq` ON `prompts` (`prompt_key`,`version`);--> statement-breakpoint
CREATE TABLE `rubric_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`rubric_key` text NOT NULL,
	`version` integer NOT NULL,
	`parent_version_id` text,
	`yaml` text NOT NULL,
	`prompt_key` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_versions_key_version_uniq` ON `rubric_versions` (`rubric_key`,`version`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`status` text NOT NULL,
	`agent_name` text DEFAULT 'claude-code' NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`tmux_session` text,
	`session_id` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`exit_code` integer,
	`iteration_count` integer DEFAULT 0 NOT NULL,
	`budget_seconds` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
