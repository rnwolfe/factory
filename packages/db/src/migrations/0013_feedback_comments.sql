CREATE TABLE `feedback_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`feedback_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`resulting_draft` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feedback_id`) REFERENCES `feedback`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `feedback_comments_feedback_created_idx` ON `feedback_comments` (`feedback_id`,`created_at`);