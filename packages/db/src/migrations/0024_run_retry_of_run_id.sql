-- Links a retry run back to the original run it was retried from. Null for
-- first-attempt runs. Enables retry-chain tracing and diff views between
-- attempts (e.g. operator retried a failed or blocked run).

ALTER TABLE `runs` ADD `retry_of_run_id` text REFERENCES `runs`(`id`);
