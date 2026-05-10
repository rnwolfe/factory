-- v0.7 — operator-driven repair on a blocked run or merge failure.
--
-- An intervention spawns a tmux session over an EXISTING worktree (no new
-- worktree creation, no own branch) so the operator can inspect git state,
-- fix conflicts, edit files, run commands. On "resume agent" the
-- intervention's terminal action is decision-kind-dependent:
--   blocked_run    → submit a NEW run with --resume <sessionId>, threading
--                    the operator's intervention summary forward
--   merge_failure  → re-run mergeIntoMain
--
-- decision_id is NOT unique here: an operator may cancel an intervention
-- and intervene again on the same decision. The orchestrate layer enforces
-- "at most one ACTIVE intervention per decision" via a query, not a
-- schema constraint, since SQLite's partial-index support varies by
-- driver. status='active' rows are operationally unique.

CREATE TABLE `interventions` (
  `id` text PRIMARY KEY NOT NULL,
  `decision_id` text NOT NULL,
  `decision_kind` text NOT NULL,
  `project_id` text NOT NULL,
  `source_run_id` text,
  `worktree_path` text NOT NULL,
  `tmux_session_name` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `started_at` integer NOT NULL,
  `ended_at` integer,
  FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`),
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);--> statement-breakpoint

CREATE INDEX `interventions_decision_status_idx`
  ON `interventions` (`decision_id`, `status`);
