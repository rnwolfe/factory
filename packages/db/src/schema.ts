import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
export const planKindEnum = [
  "project_spec",
  "task_plan",
  "refinement",
  "feature_plan",
  "project_vision",
] as const;
export const planStatusEnum = ["drafting", "frozen", "abandoned", "superseded"] as const;
export const planCommentRoleEnum = ["operator", "agent"] as const;
export const auditStatusEnum = [
  "running",
  "completed",
  "reviewed",
  "approved",
  "rejected",
  "failed",
] as const;
export const auditFindingSeverityEnum = ["critical", "major", "minor", "enhancement"] as const;
export const auditSkillKindEnum = ["read-only", "exec"] as const;
export const auditCommentRoleEnum = ["operator", "agent"] as const;
export const claudeMetricsOwnerKindEnum = [
  "run",
  "audit",
  "audit_exec",
  "plan_iteration",
  "triage",
  "audit_promote",
  "audit_comment",
] as const;

export type Goal = (typeof goalEnum)[number];
export type Tier = (typeof tierEnum)[number];
export type Tag = (typeof tagEnum)[number];
export type DecisionKind = (typeof decisionKindEnum)[number];
export type DecisionStatus = (typeof decisionStatusEnum)[number];
export type DecisionCommentRole = (typeof decisionCommentRoleEnum)[number];
export type RunStatus = (typeof runStatusEnum)[number];
export type TaskStatus = (typeof taskStatusEnum)[number];
export type PlanKind = (typeof planKindEnum)[number];
export type PlanStatus = (typeof planStatusEnum)[number];
export type PlanCommentRole = (typeof planCommentRoleEnum)[number];
export type AuditStatus = (typeof auditStatusEnum)[number];
export type AuditFindingSeverity = (typeof auditFindingSeverityEnum)[number];
export type AuditSkillKind = (typeof auditSkillKindEnum)[number];
export type AuditCommentRole = (typeof auditCommentRoleEnum)[number];
export type ClaudeMetricsOwnerKind = (typeof claudeMetricsOwnerKindEnum)[number];

/**
 * Per-model usage breakdown lifted directly from `claude --print --output-format
 * stream-json` final result envelope's `modelUsage` field. Stored as JSON in
 * `claudeMetrics.modelUsage`. Field names mirror the CLI's camelCase output.
 */
export interface ClaudeMetricsModelUsage {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Discriminated PlanDraft union — kind-specific shapes carried in `plans.draft`. */
export interface ProjectSpecDraft {
  kind: "project_spec";
  summary: string;
  tasks: Array<{
    title: string;
    estimate: "small" | "medium" | "large";
    acceptance: string[];
  }>;
  unknowns: string[];
  risks: string[];
}

export interface TaskPlanDraft {
  kind: "task_plan";
  goal: string;
  steps: Array<{ order: number; title: string; detail: string }>;
  acceptance: string[];
  /** File path globs the agent expects to modify. */
  touches: string[];
  risks: string[];
}

export interface RefinementDraft {
  kind: "refinement";
  targetTaskId: string;
  feedback: string;
  revisedAcceptance?: string[];
  followups?: Array<{ title: string; estimate: "small" | "medium" | "large" }>;
}

export interface FeaturePlanVisionFilterTest {
  passes: boolean;
  reasoning: string;
}

export interface FeaturePlanDraft {
  kind: "feature_plan";
  /** Operator-stated, immutable after creation. */
  goal: string;
  summary: string;
  tasks: Array<{
    title: string;
    estimate: "small" | "medium" | "large";
    acceptance: string[];
  }>;
  unknowns: string[];
  risks: string[];
  /**
   * The forge-style 4-test vision filter. Populated on each agent turn; read by
   * the freeze mutation as a precondition for tier ≥ personal.
   */
  visionFilter: {
    identity: FeaturePlanVisionFilterTest;
    principle: FeaturePlanVisionFilterTest;
    phase: FeaturePlanVisionFilterTest;
    replacement: FeaturePlanVisionFilterTest;
  };
}

export interface ProjectVisionDraft {
  kind: "project_vision";
  /** 2-3 sentence "what it is". */
  identity: string;
  audience: string;
  problem: string;
  designPrinciples: Array<{ name: string; meaning: string }>;
  outOfScope: string[];
  personality: string | null;
  roadmap: Array<{ phase: string; bullets: string[] }>;
  priorArt: string[];
}

export type PlanDraft =
  | ProjectSpecDraft
  | TaskPlanDraft
  | RefinementDraft
  | FeaturePlanDraft
  | ProjectVisionDraft;

export interface AuditFinding {
  /** cuid2, stable across promote calls. */
  id: string;
  severity: AuditFindingSeverity;
  /** <120 chars headline. */
  title: string;
  /** markdown body. */
  body: string;
  filePath: string | null;
  line: number | null;
  /**
   * Pointer set when the operator promoted this finding via the bridge call.
   * `id` is the new plan id (kind="plan") or new task file id (kind="task").
   * Aligned with the `finding_promoted` WS event shape.
   */
  promotedTo: { kind: "plan" | "task"; id: string } | null;
}

export interface AuditSkillFrontmatter {
  name: string;
  description: string;
  kind: AuditSkillKind;
  needsWorktree: boolean;
  defaultSeverityGrade: "enabled" | "disabled";
}

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
  /**
   * Set when the operator soft-archives the project. The project's `tag` also
   * moves to "past" so existing queries that filter on tag continue to work;
   * `archivedAt` is the explicit timestamp for sort order in the archive view.
   */
  archivedAt: integer("archived_at"),
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
  /**
   * Frozen `task_plan` plan id whose draft was folded into this run's prompt.
   * Null when the run was submitted without an attached plan (v0.1 behavior).
   */
  taskPlanId: text("task_plan_id"),
  /**
   * Captured QualityReport (JSON-stringified). Null when no quality config
   * is present in the project, or when the runner skipped the pass.
   */
  qualityReport: text("quality_report"),
  /**
   * Parsed `acceptance` array from the agent's factory-status block, when
   * the run had a frozen task_plan attached and the agent emitted per-
   * criterion results. JSON array of {criterion, met, evidence?, reason?}.
   */
  acceptanceResults: text("acceptance_results"),
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

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: planKindEnum }).notNull(),
    status: text("status", { enum: planStatusEnum }).notNull().default("drafting"),
    /** Set on `kind='project_spec'` plans created from a triage decision. */
    decisionId: text("decision_id").references(() => decisions.id),
    /** Null until the project exists (project_spec pre-freeze). */
    projectId: text("project_id").references(() => projects.id),
    /** Task IDs are file-frontmatter strings, not FKs. Null for project_spec. */
    taskId: text("task_id"),
    goal: text("goal").notNull(),
    /** Current draft payload (PlanDraft union, JSON-stringified). */
    draft: text("draft").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    frozenAt: integer("frozen_at"),
    abandonedAt: integer("abandoned_at"),
    /**
     * Claude session id captured on the first agent turn. Subsequent turns
     * resume this session instead of replaying the full prompt + thread,
     * which keeps the prompt cache warm and avoids re-billing context on
     * every operator comment. Null until the first parseable agent turn,
     * or after a prompt-version change that invalidates the session.
     */
    claudeSessionId: text("claude_session_id"),
    /**
     * Identifier for the prompt template used when the session was started,
     * shaped as `<promptKey>@<version>` (e.g. `plan-project-spec@1`). If the
     * active prompt version drifts away from this, we discard the session
     * and start fresh — the agent's resumed conversation would be operating
     * under stale instructions otherwise.
     */
    promptVersion: text("prompt_version"),
    /**
     * v0.3 — tier carried into bootstrap. Null for v0.1/v0.2 plans (treated as
     * tinker for filter purposes).
     */
    tier: text("tier", { enum: tierEnum }),
    /**
     * v0.3 — set when a newer plan in the same kind+target supersedes this
     * one. The superseded plan's status moves to "superseded".
     */
    supersededBy: text("superseded_by"),
  },
  (t) => [
    index("plans_status_created_idx").on(t.status, t.createdAt),
    index("plans_project_kind_idx").on(t.projectId, t.kind),
  ],
);

export const planComments = sqliteTable(
  "plan_comments",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .references(() => plans.id)
      .notNull(),
    role: text("role", { enum: planCommentRoleEnum }).notNull(),
    body: text("body").notNull(),
    /**
     * When the agent's turn produced a new draft, the new payload is mirrored
     * here so the diff is auditable. Null for operator comments and for agent
     * turns that failed to produce a parseable draft.
     */
    resultingDraft: text("resulting_draft"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("plan_comments_plan_created_idx").on(t.planId, t.createdAt)],
);

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type PlanComment = typeof planComments.$inferSelect;
export type NewPlanComment = typeof planComments.$inferInsert;

export const audits = sqliteTable(
  "audits",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .references(() => projects.id)
      .notNull(),
    /** matches dir name under <project>/.factory/audits/<name>/. */
    skillName: text("skill_name").notNull(),
    /** git SHA of SKILL.md at audit-start time. */
    skillVersion: text("skill_version").notNull(),
    status: text("status", { enum: auditStatusEnum }).notNull().default("running"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    /** First-open by operator. */
    reviewedAt: integer("reviewed_at"),
    approvedAt: integer("approved_at"),
    rejectedAt: integer("rejected_at"),
    /** Populated on completion. */
    reportMarkdown: text("report_markdown"),
    /** JSON-stringified array of AuditFinding. Null while running. */
    findings: text("findings"),
    /** Repo-relative, set on approval. */
    approvedReportPath: text("approved_report_path"),
    /** v0.2 session-resume mechanic for follow-up turns. */
    claudeSessionId: text("claude_session_id"),
    promptVersion: text("prompt_version"),
    /** Exec audits only; null for read-only. */
    worktreePath: text("worktree_path"),
    tmuxSessionName: text("tmux_session_name"),
    paneLogPath: text("pane_log_path"),
  },
  (t) => [
    index("audits_project_status_idx").on(t.projectId, t.status),
    index("audits_status_started_idx").on(t.status, t.startedAt),
  ],
);

export type Audit = typeof audits.$inferSelect;
export type NewAudit = typeof audits.$inferInsert;

/**
 * v0.4 cut 5 — operator/agent thread on a completed audit. Replaces the
 * "append a Discussion section to reportMarkdown" approach from v0.3 so
 * follow-ups feel structurally identical to plan and decision threads.
 * Existing audits whose reportMarkdown already carries inline `## Discussion`
 * sections are left untouched; the thread starts fresh from the next
 * comment.
 */
export const auditComments = sqliteTable(
  "audit_comments",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .references(() => audits.id)
      .notNull(),
    role: text("role", { enum: auditCommentRoleEnum }).notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("audit_comments_audit_created_idx").on(t.auditId, t.createdAt)],
);

export type AuditComment = typeof auditComments.$inferSelect;
export type NewAuditComment = typeof auditComments.$inferInsert;

/**
 * One row per terminating `claude --print` invocation, capturing the result
 * envelope's cost + token + duration metrics. The (ownerKind, ownerId) tuple
 * keys back to whichever Factory entity initiated the call (run, audit,
 * plan_iteration, triage, etc.). `projectId` is denormalized so per-project
 * roll-ups are a single index scan; null for top-level invocations that
 * predate or sidestep a project (early triage). Source: ADR for runtime
 * metrics — see docs/vision.md §7 (runtime metrics).
 */
export const claudeMetrics = sqliteTable(
  "claude_metrics",
  {
    id: text("id").primaryKey(),
    ownerKind: text("owner_kind", { enum: claudeMetricsOwnerKindEnum }).notNull(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id").references(() => projects.id),
    /** Primary model id from the result envelope's first modelUsage entry, when present. */
    model: text("model"),
    /** JSON-encoded ClaudeMetricsModelUsage map keyed by model id. */
    modelUsage: text("model_usage"),
    totalCostUsd: real("total_cost_usd").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationTokens: integer("cache_creation_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    durationMs: integer("duration_ms").notNull(),
    durationApiMs: integer("duration_api_ms").notNull(),
    numTurns: integer("num_turns").notNull(),
    sessionId: text("session_id"),
    isError: integer("is_error", { mode: "boolean" }).notNull().default(false),
    /** result envelope subtype: success | error_max_turns | error_during_execution | ... */
    subtype: text("subtype"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("claude_metrics_owner_idx").on(t.ownerKind, t.ownerId),
    index("claude_metrics_project_created_idx").on(t.projectId, t.createdAt),
    index("claude_metrics_created_idx").on(t.createdAt),
  ],
);

export type ClaudeMetrics = typeof claudeMetrics.$inferSelect;
export type NewClaudeMetrics = typeof claudeMetrics.$inferInsert;
