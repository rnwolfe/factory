import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@factory/db";
import { type AgentMetrics, commitAllChanges } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import type { FactoryConfig } from "../config.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { type InvokeClaudeResult, invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import {
  coerceMilestones,
  coerceTasks,
  type Milestone,
  type SpecDecompositionTask,
} from "./import-spec.ts";
import {
  type CreateTaskInput,
  createTask,
  listTasks,
  renderAcceptanceBlock,
  type TaskFile,
  type TaskTarget,
} from "./tasks.ts";

const MILESTONE_PROMPT_KEY = "spec-decompose-milestone-v1";
const SPEC_REL_PATH = path.posix.join("docs", "internal", "SPEC.md");

/**
 * The project context the milestone flow needs: the task store target (so
 * `createTask`/`listTasks` dispatch to the right backend) plus identity,
 * ceremony, and agent for prompt rendering + metrics.
 */
export interface MilestoneProject extends TaskTarget {
  id: string;
  ceremony?: string | null;
  agent?: string | null;
}

/** The agent's reply for one milestone: the chosen milestone, its tasks, and
 * the roadmap it recovered from the spec (so the UI can show progression). */
export interface MilestoneDecomposition {
  milestone: string;
  summary: string;
  tasks: SpecDecompositionTask[];
  unknowns: string[];
  risks: string[];
  firstTaskNote: string;
  roadmap: Milestone[];
}

export interface ProposeMilestoneInput {
  /** Operator-chosen milestone id, or omitted to let the agent infer "next". */
  milestone?: string;
}

export interface ProposeMilestoneOptions {
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
  budgetSeconds?: number;
}

export interface ProposeMilestoneResult {
  decomposition: MilestoneDecomposition;
  metrics: AgentMetrics | null;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

/**
 * Render the existing tasks as a compact, milestone-grouped digest for the
 * prompt — "what's already built or in flight." Closed tasks signal a milestone
 * is done; open ones signal in flight. Capped so a big project doesn't blow the
 * prompt budget.
 */
export function renderExistingTasks(tasks: TaskFile[]): string {
  if (tasks.length === 0) return "(no tasks yet)";
  const groups = new Map<string, TaskFile[]>();
  for (const t of tasks) {
    const key =
      typeof t.frontmatter.milestone === "string" ? t.frontmatter.milestone : "(untagged)";
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  const blocks: string[] = [];
  for (const [milestone, group] of groups) {
    const lines = group
      .slice(0, 40)
      .map((t) => `- [${t.frontmatter.status}] ${t.frontmatter.title}`);
    blocks.push(`### ${milestone}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

function coerceMilestoneDecomposition(obj: Record<string, unknown>): MilestoneDecomposition {
  const roadmap = coerceMilestones(obj.roadmap);
  const milestone =
    typeof obj.milestone === "string" && obj.milestone.trim().length > 0
      ? obj.milestone.trim()
      : (roadmap[0]?.id ?? "");
  return {
    milestone,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    tasks: coerceTasks(obj.tasks),
    unknowns: Array.isArray(obj.unknowns)
      ? obj.unknowns.filter((u): u is string => typeof u === "string")
      : [],
    risks: Array.isArray(obj.risks)
      ? obj.risks.filter((r): r is string => typeof r === "string")
      : [],
    firstTaskNote: typeof obj.firstTaskNote === "string" ? obj.firstTaskNote : "",
    roadmap,
  };
}

/**
 * Read the project's committed SPEC.md, gather its existing tasks, and run the
 * milestone-scoped decompose agent to draft the next (or a named) milestone.
 * Pure compute — no tasks are created until `confirmMilestone`. Mirrors
 * `proposeImportSpec`. See ADR-009.
 */
export async function proposeMilestone(
  db: Db,
  project: MilestoneProject,
  input: ProposeMilestoneInput = {},
  opts: ProposeMilestoneOptions = {},
): Promise<ProposeMilestoneResult> {
  const specAbsPath = path.join(project.workdirPath, SPEC_REL_PATH);
  if (!existsSync(specAbsPath)) {
    throw new Error(
      "this project has no imported spec (docs/internal/SPEC.md) — use Ship a Feature for ad-hoc work",
    );
  }
  const spec = await readFile(specAbsPath, "utf8");

  const promptRow = await db
    .select()
    .from(schema.prompts)
    .where(and(eq(schema.prompts.promptKey, MILESTONE_PROMPT_KEY), eq(schema.prompts.active, true)))
    .get();
  if (!promptRow) {
    throw new Error(`no active prompt for ${MILESTONE_PROMPT_KEY} — re-run \`bun run seed\`?`);
  }

  const existing = renderExistingTasks(await listTasks(project));
  const rendered = renderTemplate(promptRow.content, {
    INTENT_CEREMONY: project.ceremony ?? "personal",
    TARGET_MILESTONE: input.milestone?.trim() || "(next)",
    EXISTING_TASKS: existing,
    SPEC_MARKDOWN: spec,
  });

  const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();
  const agent = resolveAgent(db, { projectAgent: project.agent });
  const invocation = opts.agentInvoker
    ? await opts.agentInvoker(rendered)
    : await invokeClaudeJson(rendered, { budgetSeconds: budget, agent });

  const parsed = extractJsonObject<Record<string, unknown>>(invocation.text) ?? {};
  const metrics = invocation.metrics ?? null;
  if (metrics) {
    await recordAgentMetrics({
      db,
      ownerKind: "spec_import", // reuses the import owner kind; milestone work is the same lineage
      ownerId: createId(),
      projectId: project.id,
      agent,
      metrics,
    });
  }

  return { decomposition: coerceMilestoneDecomposition(parsed), metrics };
}

export interface ConfirmMilestoneInput {
  milestone: string;
  tasks: SpecDecompositionTask[];
}

export interface ConfirmMilestoneResult {
  taskIds: string[];
}

/**
 * Create the operator-confirmed milestone tasks into the EXISTING project (via
 * the single-point-of-truth `createTask`, so file and github-issues backends
 * both work), tag them with the milestone + provenance, and commit on main.
 */
export async function confirmMilestone(
  config: FactoryConfig,
  project: MilestoneProject,
  input: ConfirmMilestoneInput,
): Promise<ConfirmMilestoneResult> {
  const milestone = input.milestone.trim();
  const taskIds: string[] = [];
  for (const t of input.tasks) {
    if (!t) continue;
    const create: CreateTaskInput = {
      title: t.title || "Untitled",
      body: `## Acceptance\n\n${renderAcceptanceBlock(t.acceptance)}\n\n## Notes\n\n(agent-maintained)\n`,
      estimate: t.estimate ?? "small",
      priority: "med",
      labels: ["milestone-task"],
      ...(milestone ? { milestone, sourceMilestone: milestone } : {}),
    };
    const created = await createTask(project, create);
    taskIds.push(created.id);
  }

  await commitAllChanges(
    project.workdirPath,
    `chore: plan ${milestone || "milestone"} tasks from spec`,
    config.gitAuthor,
  );

  return { taskIds };
}
