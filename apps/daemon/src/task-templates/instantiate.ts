import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema, type TaskTemplateDraft, type TaskTemplateSection } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import type { EventBus } from "../events.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { loadActiveTemplate } from "../plans/apply-task-template.ts";
import { invokeClaudeJson } from "../plans/invoke-claude.ts";
import { readAgentInstructions } from "../projects/agents-md.ts";
import { type CreateTaskInput, createTask } from "../projects/tasks.ts";

export interface InstantiateTaskTemplateInput {
  db: Db;
  templateSlug: string;
  projectId: string;
  /**
   * Operator-supplied variable values keyed by variable.key. An operator value
   * always wins, even for `agent`-resolved variables (the operator can override
   * the model's pick). Missing required `operator` variables throw; missing
   * `agent` variables are filled by the model, not the operator.
   */
  variables: Record<string, string>;
  /**
   * When true, sections with `kind: "agent"` get one model invocation each
   * to tailor their body to the target project. When false, agent sections
   * fall back to a static "(agent rendering skipped — fill in)" placeholder
   * the operator can edit. Default true.
   */
  renderWithAgent?: boolean;
  /**
   * Required only when instantiating a template with `confirmInInbox` — the
   * proposal decision is published on this bus so the inbox lights up live.
   */
  events?: EventBus;
}

export interface InstantiateTaskTemplateResult {
  /**
   * `task` — a task file was created directly (the default for every template
   * without `confirmInInbox`). `proposal` — a `release_proposal` decision was
   * landed in the inbox instead; the task/run is created on operator confirm.
   */
  mode: "task" | "proposal";
  /** Set when `mode === "task"`. */
  taskId?: string;
  /** Set when `mode === "proposal"`. */
  decisionId?: string;
  title: string;
  bodyPreview: string;
  /** Variable values after operator + default + agent resolution. */
  resolvedVariables: Record<string, string>;
  /** Per-section render outcomes, surfaced so the PWA can flag agent failures. */
  sections: Array<{
    heading: string;
    kind: "static" | "agent";
    agentRendered: boolean;
    error: string | null;
  }>;
}

export class InstantiateTemplateError extends Error {
  readonly code:
    | "template_not_found"
    | "project_not_found"
    | "missing_required_variable"
    | "task_create_failed";
  constructor(code: InstantiateTaskTemplateError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "InstantiateTemplateError";
  }
}

type InstantiateTaskTemplateError = InstantiateTemplateError;

/**
 * Instantiate a task template against a target project, creating a real
 * task file in the project's `.factory/work/`.
 *
 * The render pipeline:
 *   1. Resolve variables: collected operator inputs + defaults from the
 *      template's variable definitions. Required variables without values
 *      → throw.
 *   2. For each section:
 *      - `kind: "static"`: string-substitute `{var}` placeholders against
 *        the resolved variable map (plus a few project-derived helpers like
 *        `{projectName}` and `{projectSlug}`).
 *      - `kind: "agent"`: build a render prompt with the section's
 *        instructions + project context (AGENTS.md, README, recent commits)
 *        + variable values. Invoke the model once. Substitute the response
 *        as the section body. On model error, fall back to a placeholder
 *        the operator can edit.
 *   3. Compose the final task body: each section's heading + rendered body.
 *   4. Substitute `titlePattern` against variables to get the task title.
 *   5. `createTask(...)` through the existing single-point-of-truth seam.
 */
export async function instantiateTaskTemplate(
  input: InstantiateTaskTemplateInput,
): Promise<InstantiateTaskTemplateResult> {
  const { db, templateSlug, projectId, variables: rawVars } = input;
  const renderWithAgent = input.renderWithAgent !== false;

  const template = await loadActiveTemplate(db, templateSlug);
  if (!template) {
    throw new InstantiateTemplateError(
      "template_not_found",
      `task template not found: ${templateSlug}`,
    );
  }

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) {
    throw new InstantiateTemplateError("project_not_found", `project not found: ${projectId}`);
  }

  const agent = resolveAgent(db, { projectAgent: project.agent });
  const projectContext = await gatherProjectContext(project.workdirPath);

  // Resolve operator/default variable values first; collect the keys that are
  // model-resolved (`resolver.kind === "agent"`) so they can be filled from
  // project state next. A few project-derived helpers are exposed to every
  // template (projectName/projectSlug).
  const { vars, agentKeys } = resolveVariables(template.draft, rawVars, {
    projectName: project.name,
    projectSlug: project.slug,
  });
  // Fill model-resolved variables (e.g. release version) from the project's
  // current state. An operator-supplied value already wins (it never lands in
  // agentKeys), so this only computes the ones the operator left to the model.
  // Gated on renderWithAgent: false means "no model calls at all" (agent vars
  // fall back to their default / blank), matching how agent sections behave.
  if (agentKeys.length > 0 && renderWithAgent) {
    await resolveAgentVariables({
      db,
      draft: template.draft,
      vars,
      agentKeys,
      agent,
      projectId: project.id,
      projectWorkdir: project.workdirPath,
      projectContext,
    });
  }

  // Render each section. Agent sections run model invocations in parallel
  // when there's more than one, since each is independent.
  const sectionResults = await Promise.all(
    template.draft.sections.map((section) =>
      renderSection({
        db,
        section,
        vars,
        renderWithAgent,
        agent,
        projectId: project.id,
        projectName: project.name,
        projectWorkdir: project.workdirPath,
        projectContext,
        templateName: template.draft.name,
      }),
    ),
  );

  const body = sectionResults.map(({ heading, body }) => `## ${heading}\n\n${body}`).join("\n\n");
  const title = substitute(template.draft.titlePattern, vars).trim() || template.draft.name;
  const sectionViews = sectionResults.map(({ heading, kind, agentRendered, error }) => ({
    heading,
    kind,
    agentRendered,
    error,
  }));

  // Confirm-in-inbox templates (release) don't create a task here. They land a
  // `release_proposal` decision carrying the resolved version + rendered body;
  // the task/run is created when the operator confirms (see decisions router).
  if (template.draft.confirmInInbox) {
    const decisionId = createId();
    await db.insert(schema.decisions).values({
      id: decisionId,
      kind: "release_proposal",
      projectId: project.id,
      outcome: vars.version ? `release ${vars.version}` : "release",
      payload: {
        templateSlug,
        version: vars.version ?? null,
        title,
        body,
        labels: template.draft.labels,
        priority: template.draft.priority,
        estimate: template.draft.estimate,
      },
      status: "pending",
      createdAt: Date.now(),
    });
    input.events?.publish({
      channel: "inbox",
      kind: "decision_created",
      decisionId,
      projectId: project.id,
    });
    return {
      mode: "proposal",
      decisionId,
      title,
      bodyPreview: body.slice(0, 400),
      resolvedVariables: vars,
      sections: sectionViews,
    };
  }

  const taskInput: CreateTaskInput = {
    title,
    body,
    labels: template.draft.labels,
    priority: template.draft.priority,
    estimate: template.draft.estimate,
  };
  let created: { id: string };
  try {
    created = await createTask(project, taskInput);
  } catch (err) {
    throw new InstantiateTemplateError(
      "task_create_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    mode: "task",
    taskId: created.id,
    title,
    bodyPreview: body.slice(0, 400),
    resolvedVariables: vars,
    sections: sectionViews,
  };
}

interface SectionRenderInput {
  db: Db;
  section: TaskTemplateSection;
  vars: Record<string, string>;
  renderWithAgent: boolean;
  agent: string;
  projectId: string;
  projectName: string;
  /** Project workdir — passed as cwd to the model so it can read project files via Read/Bash. */
  projectWorkdir: string;
  projectContext: ProjectContext;
  templateName: string;
}

interface SectionRenderResult {
  heading: string;
  body: string;
  kind: "static" | "agent";
  agentRendered: boolean;
  error: string | null;
}

async function renderSection(input: SectionRenderInput): Promise<SectionRenderResult> {
  const { section, vars } = input;
  if (section.kind === "static") {
    return {
      heading: section.heading,
      body: substitute(section.body, vars),
      kind: "static",
      agentRendered: false,
      error: null,
    };
  }
  // agent-rendered section
  if (!input.renderWithAgent) {
    return {
      heading: section.heading,
      body: `_(agent rendering skipped — original instruction: ${section.body})_`,
      kind: "agent",
      agentRendered: false,
      error: null,
    };
  }
  try {
    const prompt = buildAgentSectionPrompt({
      section,
      vars,
      projectName: input.projectName,
      templateName: input.templateName,
      projectContext: input.projectContext,
    });
    const inv = await invokeClaudeJson(prompt, {
      budgetSeconds: getAgentBudgetSeconds(),
      agent: input.agent as "claude-code" | "codex",
      cwd: input.projectWorkdir,
    });
    if (inv.metrics) {
      await recordAgentMetrics({
        db: input.db,
        ownerKind: "plan_iteration",
        ownerId: input.projectId,
        projectId: input.projectId,
        agent: input.agent,
        metrics: inv.metrics,
      });
    }
    return {
      heading: section.heading,
      body: inv.text.trim().length > 0 ? inv.text.trim() : `_(agent returned no body)_`,
      kind: "agent",
      agentRendered: true,
      error: null,
    };
  } catch (err) {
    return {
      heading: section.heading,
      body: `_(agent render failed: ${
        err instanceof Error ? err.message : String(err)
      }. Original instruction: ${section.body})_`,
      kind: "agent",
      agentRendered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface AgentSectionPromptInput {
  section: TaskTemplateSection;
  vars: Record<string, string>;
  projectName: string;
  templateName: string;
  projectContext: ProjectContext;
}

function buildAgentSectionPrompt(input: AgentSectionPromptInput): string {
  const { section, vars, projectName, templateName, projectContext } = input;
  const varsBlock =
    Object.entries(vars)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n") || "(none)";
  return `You are rendering a section of a task template for a specific project.

# Template
Name: ${templateName}
Section: ${section.heading}

# Instruction
${section.body}

# Target project
Name: ${projectName}

## Variables
${varsBlock}

## AGENTS.md (excerpt)
${truncate(projectContext.agentsMd, 3000)}

## README (excerpt)
${truncate(projectContext.readme, 1500)}

## Recent commits
${projectContext.recentCommits}

# Output
Reply with the rendered section body in markdown — no fenced JSON, no
preamble, no closing summary. Just the markdown that will sit directly
under the \`## ${section.heading}\` heading in the task file. Reference the
project's existing patterns where it helps the implementing agent's job.
Keep it tight: 3-10 short paragraphs or a bullet list, depending on what
the section calls for.
`;
}

interface ProjectContext {
  agentsMd: string;
  readme: string;
  recentCommits: string;
}

async function gatherProjectContext(workdirPath: string): Promise<ProjectContext> {
  const [agentsMdRaw, readmeRaw, commits] = await Promise.all([
    readAgentInstructions(workdirPath).then((v) => v ?? "(none)"),
    readFile(path.join(workdirPath, "README.md"), "utf8").catch(() => "(none)"),
    gitLogTail(workdirPath, 20),
  ]);
  return {
    agentsMd: agentsMdRaw.length > 0 ? agentsMdRaw : "(none)",
    readme: readmeRaw.length > 0 ? readmeRaw : "(none)",
    recentCommits: commits,
  };
}

async function gitLogTail(workdirPath: string, n: number): Promise<string> {
  if (!existsSync(path.join(workdirPath, ".git"))) return "(no git history)";
  try {
    const proc = bunSpawn({
      cmd: ["git", "log", `-n${n}`, "--pretty=format:%h %s"],
      cwd: workdirPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim() || "(no commits)";
  } catch {
    return "(no git history)";
  }
}

const SUB_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(SUB_RE, (match, key) => vars[key] ?? match);
}

function resolveVariables(
  draft: TaskTemplateDraft,
  rawVars: Record<string, string>,
  derived: Record<string, string>,
): { vars: Record<string, string>; agentKeys: string[] } {
  const out: Record<string, string> = { ...derived };
  const agentKeys: string[] = [];
  for (const v of draft.variables) {
    const raw = rawVars[v.key];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length > 0) {
      // An explicit operator value always wins — even over an agent resolver.
      out[v.key] = trimmed;
      continue;
    }
    if (v.resolver?.kind === "agent") {
      // Filled by the model after context is gathered; seed blank so static
      // sections referencing it don't render a literal `{key}` if resolution
      // fails. Not subject to the required-throw — the operator wasn't asked.
      out[v.key] = "";
      agentKeys.push(v.key);
      continue;
    }
    if (v.default !== null && v.default !== undefined && v.default.length > 0) {
      out[v.key] = v.default;
      continue;
    }
    if (v.required) {
      throw new InstantiateTemplateError(
        "missing_required_variable",
        `missing required variable "${v.key}" (${v.label})`,
      );
    }
    out[v.key] = "";
  }
  return { vars: out, agentKeys };
}

interface ResolveAgentVariablesInput {
  db: Db;
  draft: TaskTemplateDraft;
  vars: Record<string, string>;
  agentKeys: string[];
  agent: string;
  projectId: string;
  projectWorkdir: string;
  projectContext: ProjectContext;
}

/**
 * Fill model-resolved variables in place. Each `agent`-resolver variable gets
 * one `claude --print` pass over the project's state (last tag + commits since,
 * AGENTS.md, the variables resolved so far) and the resolver's prompt, expecting
 * a single-line value back. On failure or empty output, falls back to the
 * variable's default (or leaves it blank) — the operator edits the resolved
 * value in the proposal before confirming, so a miss is recoverable, not fatal.
 */
async function resolveAgentVariables(input: ResolveAgentVariablesInput): Promise<void> {
  const { db, draft, vars, agentKeys, agent, projectId, projectWorkdir, projectContext } = input;
  const changes = await gitChangesSinceLastTag(projectWorkdir);
  for (const key of agentKeys) {
    const def = draft.variables.find((v) => v.key === key);
    if (!def || def.resolver?.kind !== "agent") continue;
    try {
      const prompt = buildVariableResolverPrompt({
        resolverPrompt: def.resolver.prompt,
        def,
        vars,
        projectContext,
        changes,
      });
      const inv = await invokeClaudeJson(prompt, {
        budgetSeconds: getAgentBudgetSeconds(),
        agent: agent as "claude-code" | "codex",
        cwd: projectWorkdir,
      });
      if (inv.metrics) {
        await recordAgentMetrics({
          db,
          ownerKind: "plan_iteration",
          ownerId: projectId,
          projectId,
          agent,
          metrics: inv.metrics,
        });
      }
      const value = firstLineValue(inv.text);
      if (value.length > 0) vars[key] = value;
      else if (def.default) vars[key] = def.default;
    } catch {
      if (def.default) vars[key] = def.default;
    }
  }
}

interface VariableResolverPromptInput {
  resolverPrompt: string;
  def: { key: string; label: string; description: string };
  vars: Record<string, string>;
  projectContext: ProjectContext;
  changes: string;
}

function buildVariableResolverPrompt(input: VariableResolverPromptInput): string {
  const { resolverPrompt, def, vars, projectContext, changes } = input;
  const varsBlock =
    Object.entries(vars)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n") || "(none resolved yet)";
  return `You are resolving a single value for a task-template variable from the project's current state. Output ONLY the value — no prose, no markdown, no code fences.

# Variable
key: ${def.key}
label: ${def.label}
${def.description}

# How to resolve it
${resolverPrompt}

# Project state
## Last release tag + commits since
${changes}

## AGENTS.md (excerpt)
${truncate(projectContext.agentsMd, 2000)}

## Variables resolved so far
${varsBlock}

# Output
Reply with ONLY the resolved value on a single line. No preamble, no explanation, no quotes, no backticks.`;
}

/**
 * Pull a clean single-line value out of a model reply: first non-empty line,
 * with wrapping backticks/quotes and a trailing period stripped. Models tend to
 * answer a "return only the value" prompt cleanly, but occasionally wrap it.
 */
function firstLineValue(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.replace(/^[`'"]+|[`'".]+$/g, "").trim();
}

async function gitChangesSinceLastTag(workdirPath: string): Promise<string> {
  if (!existsSync(path.join(workdirPath, ".git"))) return "(no git history)";
  try {
    const tagProc = bunSpawn({
      cmd: ["git", "describe", "--tags", "--abbrev=0", "--match", "v*.*.*"],
      cwd: workdirPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const lastTag = (await new Response(tagProc.stdout).text()).trim();
    await tagProc.exited;
    const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
    const logProc = bunSpawn({
      cmd: ["git", "log", range, "--pretty=format:%h %s"],
      cwd: workdirPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const log = (await new Response(logProc.stdout).text()).trim();
    await logProc.exited;
    const header = lastTag ? `last tag: ${lastTag}` : "no prior tag (first release)";
    return `${header}\n\n${log || "(no commits since last tag)"}`;
  } catch {
    return "(git unavailable)";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated)`;
}
