CREATE TABLE `audit_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`audit_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_comments_audit_created_idx` ON `audit_comments` (`audit_id`,`created_at`);