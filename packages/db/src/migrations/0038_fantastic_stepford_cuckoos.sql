CREATE TABLE `scheduler_runs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`last_run` integer NOT NULL
);
