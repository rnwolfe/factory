import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@factory/db";
import {
  type FeaturePlanDraft,
  type Plan,
  type PlanComment,
  type PlanDraft,
  type PlanKind,
  type ProjectSpecDraft,
  type ProjectVisionDraft,
  type RefinementDraft,
  schema,
  type TaskPlanDraft,
  type TaskTemplateDraft,
} from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { readAgentInstructions } from "../projects/agents-md.ts";
import { readTaskFile } from "../projects/tasks.ts";
import type { TriageDecisionPayload } from "../triage/orchestrate.ts";
import { agentSupportsResume, type InvokeClaudeResult, invokeClaudeJson } from "./invoke-claude.ts";
import { extractJsonObject } from "./json-extract.ts";
import { planPromptKey } from "./prompts.ts";

export interface PlanAgentInvocation {
  /** Rendered prompt — full template on a fresh turn, follow-up note on resume. */
  prompt: string;
  /** When defined, the caller would have invoked `claude --resume <id>`. */
  resumeSessionId?: string;
}

export interface PlanIterationOptions {
  /**
   * Test seam — receives a description of the invocation the runtime would
   * have made and returns a synthetic claude response. Mirrors `agentInvoker`
   * in `runTriage`, but the richer signature lets tests assert that resume
   * was used and that the follow-up prompt was short.
   */
  agentInvoker?: (call: PlanAgentInvocation) => Promise<InvokeClaudeResult>;
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
  /** Session id captured from this turn (null if the agent did not emit one). */
  sessionId: string | null;
  /** True when the runtime invoked claude with `--resume` for this turn. */
  usedResume: boolean;
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

/**
 * Compose a follow-up turn prompt for a resumed claude session. The session
 * already has the full template + thread + draft history in its context, so
 * we don't replay any of it — just hand the agent the operator's latest
 * comment and re-state the envelope-completeness contract.
 *
 * The envelope is non-negotiable: every turn must emit the FULL draft, even
 * when nothing changed. The persistence layer overwrites the stored draft
 * with whatever the agent emitted — omitted fields become empty arrays /
 * empty strings. A "do not restate" instruction here would silently wipe
 * operator-approved drafts on the next conversational turn.
 */
function renderFollowUpPrompt(args: {
  kind: PlanKind;
  operatorMessage: string;
  currentDraftJson: string;
}): string {
  return [
    `The operator just commented on this ${args.kind} plan:`,
    "",
    args.operatorMessage,
    "",
    "Current draft for reference:",
    "```json",
    args.currentDraftJson,
    "```",
    "",
    `Respond with a single JSON object on stdout — the **full** ${args.kind} envelope you emitted last turn, plus an updated \`reply\` field. **Always emit every field** with current values, even when nothing changed. If the operator's note didn't move the draft, repeat the prior values verbatim — never omit a field, never emit an empty array as a "no change" signal. Omitted fields are persisted as empty and silently overwrite the operator-approved draft.`,
    "",
    "Output JSON only. The first character of your response must be `{`. No prose, no Markdown fences.",
  ].join("\n");
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
  // Seed unknowns from whichever decompose-question shape the triage emitted.
  // v2 prompts use the structured form; v1 used flat strings.
  const structured = (payload.decompose_questions ?? []).map((q) =>
    q.expected_signal ? `${q.question} (need: ${q.expected_signal})` : q.question,
  );
  const flat = payload.clarifying_questions ?? [];
  const unknowns = structured.length > 0 ? structured : flat;
  return {
    kind: "project_spec",
    summary: stub.summary ?? "",
    tasks,
    unknowns,
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

  if (kind === "feature_plan") {
    const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
    const vfRaw = (obj.visionFilter ?? {}) as Record<string, unknown>;
    const vfTest = (key: string) => {
      const v = vfRaw[key] as Record<string, unknown> | undefined;
      return {
        passes: typeof v?.passes === "boolean" ? v.passes : false,
        reasoning: typeof v?.reasoning === "string" ? v.reasoning : "(unevaluated)",
      };
    };
    const draft: FeaturePlanDraft = {
      kind: "feature_plan",
      goal: typeof obj.goal === "string" ? obj.goal : "",
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
      visionFilter: {
        identity: vfTest("identity"),
        principle: vfTest("principle"),
        phase: vfTest("phase"),
        replacement: vfTest("replacement"),
      },
    };
    return draft;
  }

  if (kind === "project_vision") {
    const principles = Array.isArray(obj.designPrinciples) ? obj.designPrinciples : [];
    const roadmap = Array.isArray(obj.roadmap) ? obj.roadmap : [];
    const draft: ProjectVisionDraft = {
      kind: "project_vision",
      identity: typeof obj.identity === "string" ? obj.identity : "",
      audience: typeof obj.audience === "string" ? obj.audience : "",
      problem: typeof obj.problem === "string" ? obj.problem : "",
      designPrinciples: principles
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
        .map((p) => ({
          name: typeof p.name === "string" ? p.name : "",
          meaning: typeof p.meaning === "string" ? p.meaning : "",
        })),
      outOfScope: Array.isArray(obj.outOfScope)
        ? obj.outOfScope.filter((o): o is string => typeof o === "string")
        : [],
      personality: typeof obj.personality === "string" ? obj.personality : null,
      roadmap: roadmap
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
        .map((r) => ({
          phase: typeof r.phase === "string" ? r.phase : "",
          bullets: Array.isArray(r.bullets)
            ? r.bullets.filter((b): b is string => typeof b === "string")
            : [],
        })),
      priorArt: Array.isArray(obj.priorArt)
        ? obj.priorArt.filter((p): p is string => typeof p === "string")
        : [],
    };
    return draft;
  }

  if (kind === "task_template") {
    const variables = Array.isArray(obj.variables) ? obj.variables : [];
    const sections = Array.isArray(obj.sections) ? obj.sections : [];
    const draft: TaskTemplateDraft = {
      kind: "task_template",
      name: typeof obj.name === "string" ? obj.name : "",
      description: typeof obj.description === "string" ? obj.description : "",
      titlePattern: typeof obj.titlePattern === "string" ? obj.titlePattern : "",
      labels: Array.isArray(obj.labels)
        ? obj.labels.filter((l): l is string => typeof l === "string")
        : [],
      priority:
        obj.priority === "low" || obj.priority === "high" || obj.priority === "med"
          ? obj.priority
          : "med",
      estimate:
        obj.estimate === "small" || obj.estimate === "medium" || obj.estimate === "large"
          ? obj.estimate
          : "medium",
      variables: variables
        .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
        .map((v) => ({
          key: typeof v.key === "string" ? v.key : "",
          label: typeof v.label === "string" ? v.label : "",
          description: typeof v.description === "string" ? v.description : "",
          required: v.required !== false,
          default: typeof v.default === "string" ? v.default : null,
        }))
        .filter((v) => v.key.length > 0),
      sections: sections
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
        .map((s) => ({
          heading: typeof s.heading === "string" ? s.heading : "",
          kind: (s.kind === "agent" ? "agent" : "static") as "agent" | "static",
          body: typeof s.body === "string" ? s.body : "",
        }))
        .filter((s) => s.heading.length > 0),
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
      INTENT_CEREMONY: idea?.intentCeremony ?? "null",
      INTENT_ROLE: idea?.intentRole ?? "null",
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
    const [readme, agentsMd] = await Promise.all([
      readIfPresent(path.join(project.workdirPath, "README.md")),
      readAgentInstructions(project.workdirPath).then((v) => v ?? "(none)"),
    ]);
    return renderPrompt(template, {
      PROJECT_NAME: project.name,
      PROJECT_README: readme,
      PROJECT_AGENTS_MD: agentsMd,
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

  if (plan.kind === "feature_plan") {
    if (!plan.projectId) throw new Error(`feature_plan ${plan.id} missing projectId`);
    const project = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, plan.projectId))
      .get();
    if (!project) throw new Error(`project ${plan.projectId} not found`);
    const [readme, agentsMd, vision] = await Promise.all([
      readIfPresent(path.join(project.workdirPath, "README.md")),
      readAgentInstructions(project.workdirPath).then((v) => v ?? "(none)"),
      readIfPresent(path.join(project.workdirPath, "docs", "internal", "VISION.md")),
    ]);
    return renderPrompt(template, {
      PROJECT_NAME: project.name,
      PROJECT_CEREMONY: plan.ceremony ?? project.ceremony ?? "tinker",
      PROJECT_README: readme,
      PROJECT_AGENTS_MD: agentsMd,
      PROJECT_VISION: vision,
      FEATURE_GOAL: plan.goal,
      CURRENT_DRAFT_JSON: draftJson,
      THREAD: formatThread(thread),
    });
  }

  if (plan.kind === "project_vision") {
    if (!plan.projectId) throw new Error(`project_vision ${plan.id} missing projectId`);
    const project = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, plan.projectId))
      .get();
    if (!project) throw new Error(`project ${plan.projectId} not found`);
    const [readme, agentsMd, existingVision] = await Promise.all([
      readIfPresent(path.join(project.workdirPath, "README.md")),
      readAgentInstructions(project.workdirPath).then((v) => v ?? "(none)"),
      readIfPresent(path.join(project.workdirPath, "docs", "internal", "VISION.md")),
    ]);
    // Recent commit log is grounding for the agent's identity statement —
    // best signal of what the project actually does today.
    let recentCommits = "(no git history)";
    try {
      const { spawn: bunSpawn } = await import("bun");
      const proc = bunSpawn({
        cmd: ["git", "log", "-n30", "--pretty=format:%h %s"],
        cwd: project.workdirPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      if (out.trim().length > 0) recentCommits = out.trim();
    } catch {
      // ignore
    }
    return renderPrompt(template, {
      PROJECT_NAME: project.name,
      PROJECT_CEREMONY: plan.ceremony ?? project.ceremony ?? "tinker",
      PROJECT_README: readme,
      PROJECT_AGENTS_MD: agentsMd,
      EXISTING_VISION: existingVision,
      RECENT_COMMITS: recentCommits,
      CURRENT_DRAFT_JSON: draftJson,
      THREAD: formatThread(thread),
    });
  }

  if (plan.kind === "task_template") {
    // Cross-project templates have no projectId — the goal (stored on the
    // plan's `goal` column when it was created) carries the operator's
    // stated intent. No project context is fed in; the template itself
    // must remain project-agnostic.
    return renderPrompt(template, {
      TEMPLATE_GOAL: plan.goal ?? "(operator's goal unset)",
      CURRENT_DRAFT_JSON: draftJson,
      THREAD: formatThread(thread),
    });
  }

  throw new Error(`unhandled plan kind: ${plan.kind}`);
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

  const currentPromptVersion = `${promptKey}@${promptRow.version}`;
  const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();

  // Resume conditions: we have a captured session id, the prompt version is
  // unchanged since the session started (otherwise the resumed agent is
  // running under stale instructions), and there's at least one prior agent
  // turn (without one, the session can't really exist anyway). The latest
  // operator comment is the conversational input the follow-up needs.
  //
  // For agents without `--resume` (codex), we additionally suppress the
  // resume branch and always send the full prompt — buildPromptForKind
  // re-renders the entire thread into the template, so correctness is
  // preserved (at the cost of more tokens per turn). See codex-parity §3b.
  // Plans that target a project (everything except triage-stage project_spec
  // before the project materializes) honor that project's agent column. The
  // outer `buildPromptForKind` already loaded the project for plan kinds that
  // need it; for the remaining cases we look it up here when projectId is set.
  const planProject = plan.projectId
    ? await db
        .select({ agent: schema.projects.agent })
        .from(schema.projects)
        .where(eq(schema.projects.id, plan.projectId))
        .get()
    : null;
  const agentName = resolveAgent(db, { projectAgent: planProject?.agent });
  const lastOperatorComment = [...thread].reverse().find((c) => c.role === "operator");
  const hasPriorAgentTurn = thread.some((c) => c.role === "agent");
  const canResume =
    agentSupportsResume(agentName) &&
    Boolean(plan.claudeSessionId) &&
    plan.promptVersion === currentPromptVersion &&
    hasPriorAgentTurn &&
    Boolean(lastOperatorComment);

  // Build both candidate prompts up front. `resumed` may be skipped at call
  // time, but rendering both keeps the fall-back path zero-cost.
  const fullPrompt = await buildPromptForKind(db, plan, thread, promptRow.content);
  const followUpPrompt =
    canResume && lastOperatorComment
      ? renderFollowUpPrompt({
          kind: plan.kind,
          operatorMessage: lastOperatorComment.body,
          currentDraftJson: plan.draft,
        })
      : null;

  async function callAgent(call: PlanAgentInvocation): Promise<InvokeClaudeResult> {
    if (opts.agentInvoker) return opts.agentInvoker(call);
    return invokeClaudeJson(call.prompt, {
      budgetSeconds: budget,
      agent: agentName,
      resumeSessionId: call.resumeSessionId,
    });
  }

  let invocation: InvokeClaudeResult;
  let usedResume = false;
  try {
    if (canResume && followUpPrompt && plan.claudeSessionId) {
      try {
        invocation = await callAgent({
          prompt: followUpPrompt,
          resumeSessionId: plan.claudeSessionId,
        });
        usedResume = true;
      } catch (resumeErr) {
        // The CLI evicts old sessions and a `--resume` against a missing
        // session is a hard error. Fall back to a fresh invocation with the
        // full template + thread, which always works. Stamp the session
        // fields null so we don't keep retrying the bad id.
        await db
          .update(schema.plans)
          .set({ claudeSessionId: null, promptVersion: null, updatedAt: now })
          .where(eq(schema.plans.id, planId))
          .run();
        const message = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        console.warn(
          `[plans] resume failed for plan ${planId} (${message.slice(0, 120)}); falling back to fresh prompt`,
        );
        invocation = await callAgent({ prompt: fullPrompt });
      }
    } else {
      invocation = await callAgent({ prompt: fullPrompt });
    }
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
      sessionId: null,
      usedResume,
    };
  }
  if (invocation.metrics) {
    await recordAgentMetrics({
      db,
      ownerKind: "plan_iteration",
      ownerId: planId,
      projectId: plan.projectId ?? null,
      agent: agentName,
      metrics: invocation.metrics,
      now,
    });
  }
  const responseText = invocation.text;
  const newSessionId = invocation.sessionId;

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
      sessionId: newSessionId,
      usedResume,
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
      sessionId: newSessionId,
      usedResume,
    };
  }

  // refinement plans carry the targetTaskId from the plan row; the agent
  // doesn't need to reproduce it.
  if (newDraft.kind === "refinement" && plan.taskId) {
    newDraft.targetTaskId = plan.taskId;
  }

  const draftJson = JSON.stringify(newDraft);
  const commentId = createId();

  // Persist the session id + prompt-version stamp on success so the *next*
  // iteration can resume. If the CLI rotated the id (it sometimes does on
  // resume), the new value supersedes the old. On a fresh invocation that
  // didn't yield a session id (e.g. a flag-stripped CI agent), we leave the
  // existing value alone — better to let the caller rebuild it next turn
  // than to wipe a still-valid session.
  const planUpdate: Partial<typeof schema.plans.$inferInsert> = {
    draft: draftJson,
    updatedAt: now,
  };
  if (newSessionId) {
    planUpdate.claudeSessionId = newSessionId;
    planUpdate.promptVersion = currentPromptVersion;
  }

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
    tx.update(schema.plans).set(planUpdate).where(eq(schema.plans.id, planId)).run();
  });

  return {
    planId,
    agentCommentId: commentId,
    draftUpdated: true,
    draft: newDraft,
    parseError: null,
    sessionId: newSessionId,
    usedResume,
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

/** Helper to seed an empty feature_plan draft. */
export function seedFeaturePlanDraft(goal: string): FeaturePlanDraft {
  return {
    kind: "feature_plan",
    goal,
    summary: "",
    tasks: [],
    unknowns: [],
    risks: [],
    visionFilter: {
      identity: { passes: false, reasoning: "(unevaluated)" },
      principle: { passes: false, reasoning: "(unevaluated)" },
      phase: { passes: false, reasoning: "(unevaluated)" },
      replacement: { passes: false, reasoning: "(unevaluated)" },
    },
  };
}

/** Helper to seed an empty project_vision draft. */
export function seedProjectVisionDraft(): ProjectVisionDraft {
  return {
    kind: "project_vision",
    identity: "",
    audience: "",
    problem: "",
    designPrinciples: [],
    outOfScope: [],
    personality: null,
    roadmap: [],
    priorArt: [],
  };
}

/** Parse the JSON-stringified draft column back into a discriminated union. */
export function parseStoredDraft(raw: string): PlanDraft {
  return parseDraft(raw);
}
