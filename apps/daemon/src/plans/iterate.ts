import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@factory/db";
import {
  type Plan,
  type PlanComment,
  type PlanDraft,
  type PlanKind,
  type ProjectSpecDraft,
  type RefinementDraft,
  schema,
  type TaskPlanDraft,
} from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq } from "drizzle-orm";
import { readTaskFile } from "../projects/tasks.ts";
import type { TriageDecisionPayload } from "../triage/orchestrate.ts";
import { invokeClaudeJson } from "./invoke-claude.ts";
import { extractJsonObject } from "./json-extract.ts";
import { planPromptKey } from "./prompts.ts";

const PLAN_BUDGET_SECONDS = 120;

export interface PlanIterationOptions {
  /**
   * Test seam — receives the rendered prompt and returns the raw agent
   * response. Mirrors `agentInvoker` in `runTriage` so plan tests can
   * skip spawning real `claude` processes.
   */
  agentInvoker?: (prompt: string) => Promise<string>;
  /** Wall-clock cap. Default 120s, matching triage. */
  budgetSeconds?: number;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
}

export interface PlanIterationResult {
  planId: string;
  /** Comment row appended to the thread. */
  agentCommentId: string;
  /** True when the agent's response parsed cleanly and `draft` was updated. */
  draftUpdated: boolean;
  /** The new draft on success, or null if parse failed. */
  draft: PlanDraft | null;
  /** Parse error message when the agent's response could not be parsed. */
  parseError: string | null;
}

interface PlanAgentResponse {
  reply?: unknown;
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function formatThread(comments: PlanComment[]): string {
  if (comments.length === 0) return "(no prior messages)";
  return comments
    .map((c) => `[${c.role} · ${new Date(c.createdAt).toISOString()}]\n${c.body}`)
    .join("\n\n");
}

function parseDraft(raw: string): PlanDraft {
  return JSON.parse(raw) as PlanDraft;
}

function projectSpecDraftFromPayload(payload: TriageDecisionPayload): ProjectSpecDraft {
  const stub = payload.spec_stub ?? {};
  const tasks = (stub.initial_tasks ?? []).map((t) => ({
    title: t.title,
    estimate: t.estimate ?? "small",
    acceptance: t.acceptance ?? [],
  }));
  return {
    kind: "project_spec",
    summary: stub.summary ?? "",
    tasks,
    unknowns: payload.clarifying_questions ?? [],
    risks: [],
  };
}

/**
 * Coerce parsed JSON into a kind-specific draft. The agent's prompt tells it
 * the schema, but field-by-field validation here keeps later code from
 * crashing on missing arrays (defensive — the agent occasionally emits an
 * object instead of a list, etc.).
 */
function coerceDraft(kind: PlanKind, raw: unknown): PlanDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (kind === "project_spec") {
    const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
    const draft: ProjectSpecDraft = {
      kind: "project_spec",
      summary: typeof obj.summary === "string" ? obj.summary : "",
      tasks: tasks
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
        .map((t) => ({
          title: typeof t.title === "string" ? t.title : "Untitled",
          estimate:
            t.estimate === "small" || t.estimate === "medium" || t.estimate === "large"
              ? t.estimate
              : "small",
          acceptance: Array.isArray(t.acceptance)
            ? t.acceptance.filter((a): a is string => typeof a === "string")
            : [],
        })),
      unknowns: Array.isArray(obj.unknowns)
        ? obj.unknowns.filter((u): u is string => typeof u === "string")
        : [],
      risks: Array.isArray(obj.risks)
        ? obj.risks.filter((r): r is string => typeof r === "string")
        : [],
    };
    return draft;
  }

  if (kind === "task_plan") {
    const stepsRaw = Array.isArray(obj.steps) ? obj.steps : [];
    const draft: TaskPlanDraft = {
      kind: "task_plan",
      goal: typeof obj.goal === "string" ? obj.goal : "",
      steps: stepsRaw
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
        .map((s, i) => ({
          order: typeof s.order === "number" ? s.order : i + 1,
          title: typeof s.title === "string" ? s.title : "",
          detail: typeof s.detail === "string" ? s.detail : "",
        })),
      acceptance: Array.isArray(obj.acceptance)
        ? obj.acceptance.filter((a): a is string => typeof a === "string")
        : [],
      touches: Array.isArray(obj.touches)
        ? obj.touches.filter((t): t is string => typeof t === "string")
        : [],
      risks: Array.isArray(obj.risks)
        ? obj.risks.filter((r): r is string => typeof r === "string")
        : [],
    };
    return draft;
  }

  if (kind === "refinement") {
    const followupsRaw = Array.isArray(obj.followups) ? obj.followups : [];
    const targetTaskId =
      typeof obj.targetTaskId === "string" && obj.targetTaskId.length > 0 ? obj.targetTaskId : null;
    const draft: RefinementDraft = {
      kind: "refinement",
      targetTaskId: targetTaskId ?? "",
      feedback: typeof obj.feedback === "string" ? obj.feedback : "",
      revisedAcceptance: Array.isArray(obj.revisedAcceptance)
        ? obj.revisedAcceptance.filter((a): a is string => typeof a === "string")
        : undefined,
      followups:
        followupsRaw.length > 0
          ? followupsRaw
              .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
              .map((f) => ({
                title: typeof f.title === "string" ? f.title : "Untitled",
                estimate:
                  f.estimate === "small" || f.estimate === "medium" || f.estimate === "large"
                    ? f.estimate
                    : "small",
              }))
          : undefined,
    };
    return draft;
  }

  return null;
}

function extractReply(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const obj = raw as PlanAgentResponse;
    if (typeof obj.reply === "string" && obj.reply.trim().length > 0) {
      return obj.reply.trim();
    }
  }
  return "(agent did not include a reply)";
}

async function readIfPresent(filePath: string): Promise<string> {
  if (!existsSync(filePath)) return "(none)";
  try {
    const content = await readFile(filePath, "utf8");
    return content.trim().length > 0 ? content : "(none)";
  } catch {
    return "(none)";
  }
}

async function buildPromptForKind(
  db: Db,
  plan: Plan,
  thread: PlanComment[],
  template: string,
): Promise<string> {
  const draftJson = plan.draft;

  if (plan.kind === "project_spec") {
    if (!plan.decisionId) throw new Error(`project_spec plan ${plan.id} missing decisionId`);
    const decision = await db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, plan.decisionId))
      .get();
    if (!decision) throw new Error(`decision ${plan.decisionId} not found`);
    const idea = decision.ideaId
      ? await db.select().from(schema.ideas).where(eq(schema.ideas.id, decision.ideaId)).get()
      : null;
    return renderPrompt(template, {
      IDEA_TEXT: idea?.rawText ?? "(idea unavailable)",
      GOAL_HINT: idea?.goalHint ?? "null",
      TRIAGE_PAYLOAD_JSON: JSON.stringify(decision.payload, null, 2),
      CURRENT_DRAFT_JSON: draftJson,
      THREAD: formatThread(thread),
    });
  }

  if (plan.kind === "task_plan") {
    if (!plan.projectId) throw new Error(`task_plan ${plan.id} missing projectId`);
    if (!plan.taskId) throw new Error(`task_plan ${plan.id} missing taskId`);
    const project = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, plan.projectId))
      .get();
    if (!project) throw new Error(`project ${plan.projectId} not found`);
    const task = await readTaskFile(project.workdirPath, plan.taskId);
    const [readme, claudeMd] = await Promise.all([
      readIfPresent(path.join(project.workdirPath, "README.md")),
      readIfPresent(path.join(project.workdirPath, "CLAUDE.md")),
    ]);
    return renderPrompt(template, {
      PROJECT_NAME: project.name,
      PROJECT_README: readme,
      PROJECT_CLAUDE_MD: claudeMd,
      TASK_BODY: task?.body ?? "(task body unavailable)",
      CURRENT_DRAFT_JSON: draftJson,
      THREAD: formatThread(thread),
    });
  }

  if (plan.kind === "refinement") {
    if (!plan.projectId) throw new Error(`refinement ${plan.id} missing projectId`);
    if (!plan.taskId) throw new Error(`refinement ${plan.id} missing taskId`);
    const project = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, plan.projectId))
      .get();
    if (!project) throw new Error(`project ${plan.projectId} not found`);
    const task = await readTaskFile(project.workdirPath, plan.taskId);

    // Source run = the most recent completed run on the task. The plan
    // doesn't carry runId directly (refinement may target the task without a
    // specific run, e.g., "this whole task needs work") but we surface the
    // last run's summary as default context. The freeze action keys off the
    // task, not the run.
    const sourceRun = await db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.projectId, plan.projectId), eq(schema.runs.taskId, plan.taskId)))
      .orderBy(asc(schema.runs.startedAt))
      .all();
    const last = sourceRun.at(-1);

    return renderPrompt(template, {
      TASK_ID: plan.taskId,
      TASK_BODY: task?.body ?? "(task body unavailable)",
      SOURCE_RUN_SUMMARY: last?.summary ?? "(no prior run)",
      SOURCE_RUN_COMMITS: last ? `branch ${last.branch}` : "(none)",
      CURRENT_DRAFT_JSON: draftJson,
      THREAD: formatThread(thread),
    });
  }

  throw new Error(`feature_plan iteration not implemented in v0.2 (plan ${plan.id})`);
}

/**
 * Run a single plan iteration: load the plan + thread + kind-specific context,
 * call the agent, parse, persist a new comment + (on success) updated draft.
 *
 * Mirrors the triage follow-up shape: the operator's comment is already in
 * the thread when this is called. Returns when the agent's reply has been
 * persisted; the caller is responsible for broadcasting WS events afterwards.
 */
export async function runPlanIteration(
  db: Db,
  planId: string,
  opts: PlanIterationOptions = {},
): Promise<PlanIterationResult> {
  const now = (opts.now ?? Date.now)();

  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).get();
  if (!plan) throw new Error(`plan ${planId} not found`);
  if (plan.status !== "drafting") {
    throw new Error(`plan ${planId} is ${plan.status}; only drafting plans iterate`);
  }
  if (plan.kind === "feature_plan") {
    throw new Error(`feature_plan iteration not implemented in v0.2 (plan ${planId})`);
  }

  const thread = await db
    .select()
    .from(schema.planComments)
    .where(eq(schema.planComments.planId, planId))
    .orderBy(asc(schema.planComments.createdAt))
    .all();

  const promptKey = planPromptKey(plan.kind);
  const promptRow = await db
    .select()
    .from(schema.prompts)
    .where(and(eq(schema.prompts.promptKey, promptKey), eq(schema.prompts.active, true)))
    .get();
  if (!promptRow) {
    throw new Error(`no active prompt for ${promptKey} — re-run \`bun run seed\`?`);
  }

  const rendered = await buildPromptForKind(db, plan, thread, promptRow.content);
  const budget = Math.min(opts.budgetSeconds ?? PLAN_BUDGET_SECONDS, PLAN_BUDGET_SECONDS);

  let responseText: string;
  try {
    responseText = opts.agentInvoker
      ? await opts.agentInvoker(rendered)
      : await invokeClaudeJson(rendered, budget);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const commentId = createId();
    await db.insert(schema.planComments).values({
      id: commentId,
      planId,
      role: "agent",
      body: `(plan iteration failed: ${message.slice(0, 240)})`,
      resultingDraft: null,
      createdAt: now,
    });
    return {
      planId,
      agentCommentId: commentId,
      draftUpdated: false,
      draft: null,
      parseError: message,
    };
  }

  let parsedRaw: unknown;
  let parseError: string | null = null;
  try {
    parsedRaw = extractJsonObject<unknown>(responseText);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  if (parseError !== null) {
    const commentId = createId();
    const trailer = `\n\n_(plan iteration failed: malformed JSON — draft unchanged)_`;
    const head = responseText.trim().slice(0, 1200) || "(no agent output)";
    await db.insert(schema.planComments).values({
      id: commentId,
      planId,
      role: "agent",
      body: `${head}${trailer}`,
      resultingDraft: null,
      createdAt: now,
    });
    return {
      planId,
      agentCommentId: commentId,
      draftUpdated: false,
      draft: null,
      parseError,
    };
  }

  const newDraft = coerceDraft(plan.kind, parsedRaw);
  const reply = extractReply(parsedRaw);

  if (!newDraft) {
    const commentId = createId();
    await db.insert(schema.planComments).values({
      id: commentId,
      planId,
      role: "agent",
      body: `${reply}\n\n_(plan iteration failed: response did not match the ${plan.kind} schema — draft unchanged)_`,
      resultingDraft: null,
      createdAt: now,
    });
    return {
      planId,
      agentCommentId: commentId,
      draftUpdated: false,
      draft: null,
      parseError: `coerce-${plan.kind} returned null`,
    };
  }

  // refinement plans carry the targetTaskId from the plan row; the agent
  // doesn't need to reproduce it.
  if (newDraft.kind === "refinement" && plan.taskId) {
    newDraft.targetTaskId = plan.taskId;
  }

  const draftJson = JSON.stringify(newDraft);
  const commentId = createId();

  await db.transaction((tx) => {
    tx.insert(schema.planComments)
      .values({
        id: commentId,
        planId,
        role: "agent",
        body: reply,
        resultingDraft: draftJson,
        createdAt: now,
      })
      .run();
    tx.update(schema.plans)
      .set({ draft: draftJson, updatedAt: now })
      .where(eq(schema.plans.id, planId))
      .run();
  });

  return {
    planId,
    agentCommentId: commentId,
    draftUpdated: true,
    draft: newDraft,
    parseError: null,
  };
}

/** Helper to seed a project_spec draft from a triage decision payload. */
export function seedProjectSpecDraft(payload: TriageDecisionPayload): ProjectSpecDraft {
  return projectSpecDraftFromPayload(payload);
}

/** Helper to seed an empty task_plan draft. */
export function seedTaskPlanDraft(): TaskPlanDraft {
  return {
    kind: "task_plan",
    goal: "",
    steps: [],
    acceptance: [],
    touches: [],
    risks: [],
  };
}

/** Helper to seed an empty refinement draft against a task. */
export function seedRefinementDraft(targetTaskId: string): RefinementDraft {
  return {
    kind: "refinement",
    targetTaskId,
    feedback: "",
    revisedAcceptance: undefined,
    followups: undefined,
  };
}

/** Parse the JSON-stringified draft column back into a discriminated union. */
export function parseStoredDraft(raw: string): PlanDraft {
  return parseDraft(raw);
}
