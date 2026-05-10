-- v0.7 — operator-managed bridge for long-running work that exceeds a
-- single `claude --print` turn.
--
-- The agent emits a `factory-defer` block declaring a command, a self-
-- summary, and a continuation prompt. Factory spawns the command as a
-- child of the daemon (NOT in the agent's tmux — that pty closes when
-- the agent's --print exits, killing anything still attached) and
-- tracks it here. On completion the daemon submits a continuation run
-- reusing the source's worktree (so all the gitignored build state is
-- right there), with the continuation prompt + structured outcome
-- block folded in via operatorContext.
--
-- `pid` lets the boot reaper decide between `running` and `orphaned`
-- after a daemon restart: detached subprocesses survive, but the
-- daemon loses the wait handle.

CREATE TABLE `deferred_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `project_id` text NOT NULL,
  `command` text NOT NULL,
  `summary` text NOT NULL,
  `continuation_prompt` text NOT NULL,
  `log_path` text NOT NULL,
  `status` text NOT NULL DEFAULT 'queued',
  `pid` integer,
  `started_at` integer NOT NULL,
  `ended_at` integer,
  `exit_code` integer,
  `continuation_run_id` text,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`),
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);--> statement-breakpoint

CREATE INDEX `deferred_tasks_run_idx` ON `deferred_tasks` (`run_id`);--> statement-breakpoint

CREATE INDEX `deferred_tasks_status_started_idx`
  ON `deferred_tasks` (`status`, `started_at`);
