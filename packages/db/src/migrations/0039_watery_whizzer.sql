CREATE INDEX `decisions_status_created_idx` ON `decisions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `decisions_project_idx` ON `decisions` (`project_id`);--> statement-breakpoint
CREATE INDEX `events_run_id_idx` ON `events` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_run_kind_idx` ON `events` (`run_id`,`kind`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`);