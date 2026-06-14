ALTER TABLE `audits` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `decisions` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `feedback` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `snoozed_until` integer;