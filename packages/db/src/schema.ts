import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const goalEnum = ["me", "learn", "share", "productize"] as const;
export const tierEnum = ["tinker", "personal", "share", "productize"] as const;
export const tagEnum = ["active", "background", "past"] as const;
export const decisionKindEnum = ["triage", "tag_change", "blocked_run", "merge_failure"] as const;
export const decisionStatusEnum = ["pending", "actioned", "dismissed"] as const;
export const decisionCommentRoleEnum = ["operator", "agent"] as const;
export const runStatusEnum = [
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
  "blocked",
] as const;
export const taskStatusEnum = [
  "ready",
  "in_progress",
  "review",
  "done",
  "blocked",
  "dropped",
] as const;

export type Goal = (typeof goalEnum)[number];
export type Tier = (typeof tierEnum)[number];
export type Tag = (typeof tagEnum)[number];
export type DecisionKind = (typeof decisionKindEnum)[number];
export type DecisionStatus = (typeof decisionStatusEnum)[number];
export type DecisionCommentRole = (typeof decisionCommentRoleEnum)[number];
export type RunStatus = (typeof runStatusEnum)[number];
export type TaskStatus = (typeof taskStatusEnum)[number];

export const ideas = sqliteTable("ideas", {
  id: text("id").primaryKey(),
  rawText: text("raw_text").notNull(),
  goalHint: text("goal_hint", { enum: goalEnum }),
  source: text("source").notNull(),
  createdAt: integer("created_at").notNull(),
  triagedAt: integer("triaged_at"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ideaId: text("idea_id").references(() => ideas.id),
  goal: text("goal", { enum: goalEnum }).notNull(),
  tier: text("tier", { enum: tierEnum }).notNull(),
  tag: text("tag", { enum: tagEnum }).notNull().default("active"),
  workdirPath: text("workdir_path").notNull(),
  createdAt: integer("created_at").notNull(),
  lastActivityAt: integer("last_activity_at").notNull(),
  /** When true, runs auto-submit the next ready task on success. Default: on. */
  autoAdvance: integer("auto_advance", { mode: "boolean" }).notNull().default(true),
  /** Claude model id used for runs in this project. Null = CLI default. */
  model: text("model"),
});

export const rubricVersions = sqliteTable(
  "rubric_versions",
  {
    id: text("id").primaryKey(),
    rubricKey: text("rubric_key").notNull(),
    version: integer("version").notNull(),
    parentVersionId: text("parent_version_id"),
    yaml: text("yaml").notNull(),
    promptKey: text("prompt_key").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    message: text("message"),
  },
  (t) => [uniqueIndex("rubric_versions_key_version_uniq").on(t.rubricKey, t.version)],
);

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: decisionKindEnum }).notNull(),
  ideaId: text("idea_id").references(() => ideas.id),
  projectId: text("project_id").references(() => projects.id),
  rubricVersionId: text("rubric_version_id").references(() => rubricVersions.id),
  outcome: text("outcome").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  uncertainty: real("uncertainty"),
  weightedScore: real("weighted_score"),
  status: text("status", { enum: decisionStatusEnum }).notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  actionedAt: integer("actioned_at"),
});

export const decisionComments = sqliteTable("decision_comments", {
  id: text("id").primaryKey(),
  decisionId: text("decision_id")
    .references(() => decisions.id)
    .notNull(),
  role: text("role", { enum: decisionCommentRoleEnum }).notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .references(() => projects.id)
    .notNull(),
  taskId: text("task_id"),
  status: text("status", { enum: runStatusEnum }).notNull(),
  agentName: text("agent_name").notNull().default("claude-code"),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  tmuxSession: text("tmux_session"),
  sessionId: text("session_id"),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  exitCode: integer("exit_code"),
  iterationCount: integer("iteration_count").notNull().default(0),
  budgetSeconds: integer("budget_seconds").notNull(),
  /** Operator-facing wrap-up extracted from the agent's factory-status block. */
  summary: text("summary"),
  /** When status='blocked', the JSON-stringified array of agent questions. */
  blockerQuestions: text("blocker_questions"),
  /**
   * Optional baseRef the worktree was created from. Defaults to project HEAD
   * when null. Used by the retry path so a new run can resume from a prior
   * (e.g. blocked) run's branch tip instead of starting fresh.
   */
  baseRef: text("base_ref"),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id")
    .references(() => runs.id)
    .notNull(),
  iteration: integer("iteration").notNull(),
  ts: integer("ts").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
});

export const prompts = sqliteTable(
  "prompts",
  {
    id: text("id").primaryKey(),
    promptKey: text("prompt_key").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("prompts_key_version_uniq").on(t.promptKey, t.version)],
);

export type Idea = typeof ideas.$inferSelect;
export type NewIdea = typeof ideas.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type DecisionComment = typeof decisionComments.$inferSelect;
export type NewDecisionComment = typeof decisionComments.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type RubricVersion = typeof rubricVersions.$inferSelect;
export type NewRubricVersion = typeof rubricVersions.$inferInsert;
export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;
