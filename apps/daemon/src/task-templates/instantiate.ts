import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema, type TaskTemplateDraft, type TaskTemplateSection } from "@factory/db";
import { spawn as bunSpawn } from "bun";
import { eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import { recordAgentMetrics } from "../metrics/record.ts";
import { loadActiveTemplate } from "../plans/apply-task-template.ts";
import { invokeClaudeJson } from "../plans/invoke-claude.ts";
import { readAgentInstructions } from "../projects/agents-md.ts";
import { type CreateTaskInput, createTask } from "../projects/tasks.ts";

export interface InstantiateTaskTemplateInput {
  db: Db;
  templateSlug: string;
  projectId: string;
  /** Variable values keyed by variable.key. Missing required values throws. */
  variables: Record<string, string>;
  /**
   * When true, sections with `kind: "agent"` get one model invocation each
   * to tailor their body to the target project. When false, agent sections
   * fall back to a static "(agent rendering skipped — fill in)" placeholder
   * the operator can edit. Default true.
   */
  renderWithAgent?: boolean;
}

export interface InstantiateTaskTemplateResult {
  taskId: string;
  title: string;
  bodyPreview: string;
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

  // Resolve effective variable map: operator inputs + defaults + a few
  // project-derived helpers exposed to every template.
  const vars = resolveVariables(template.draft, rawVars, {
    projectName: project.name,
    projectSlug: project.slug,
  });

  // Render each section. Agent sections run model invocations in parallel
  // when there's more than one, since each is independent.
  const agent = resolveAgent(db, { projectAgent: project.agent });
  const projectContext = await gatherProjectContext(project.workdirPath);
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
        projectContext,
        templateName: template.draft.name,
      }),
    ),
  );

  const body = sectionResults.map(({ heading, body }) => `## ${heading}\n\n${body}`).join("\n\n");
  const title = substitute(template.draft.titlePattern, vars).trim() || template.draft.name;

  const taskInput: CreateTaskInput = {
    title,
    body,
    labels: template.draft.labels,
    priority: template.draft.priority,
    estimate: template.draft.estimate,
  };
  let created: { id: string };
  try {
    created = await createTask(project.workdirPath, taskInput);
  } catch (err) {
    throw new InstantiateTemplateError(
      "task_create_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    taskId: created.id,
    title,
    bodyPreview: body.slice(0, 400),
    sections: sectionResults.map(({ heading, kind, agentRendered, error }) => ({
      heading,
      kind,
      agentRendered,
      error,
    })),
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
): Record<string, string> {
  const out: Record<string, string> = { ...derived };
  for (const v of draft.variables) {
    const raw = rawVars[v.key];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed.length > 0) {
      out[v.key] = trimmed;
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
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated)`;
}
