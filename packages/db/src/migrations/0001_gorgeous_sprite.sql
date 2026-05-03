CREATE TABLE `decision_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
