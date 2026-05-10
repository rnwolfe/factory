-- Operator answers / extra context that ride into a retry of a blocked run.
-- Set by the blocked_run decision approve path: when the operator replies in
-- the decision thread and then approves (= retry), the gathered comments are
-- joined and written here. The runner prepends them to the agent's prompt as
-- a top-level "Operator notes" section so the new run starts with answers to
-- the agent's prior questions instead of repeating itself.

ALTER TABLE `runs` ADD `operator_context` text;
