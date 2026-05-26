import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import { getAgentBudgetSeconds } from "../agent-budget.ts";
import { resolveAgent } from "../agents/resolve.ts";
import type { FactoryConfig } from "../config.ts";
import { recordClaudeMetrics } from "../metrics/record.ts";
import { type InvokeClaudeResult, invokeClaudeJson } from "../plans/invoke-claude.ts";
import { extractJsonObject } from "../plans/json-extract.ts";
import type { TriageDecisionPayload } from "../triage/orchestrate.ts";
import { agentsMdPath, ensureClaudeMdSymlink } from "./agents-md.ts";
import { type BootstrapResult, bootstrapProject } from "./bootstrap.ts";

export type Ceremony = "tinker" | "personal" | "shared" | "production";
export type Role = "owner" | "contributor";

const SPEC_DECOMPOSE_PROMPT_KEY = "spec-decompose-v1";

export interface SpecDecompositionTask {
  title: string;
  estimate: "small" | "medium" | "large";
  acceptance: string[];
}

export interface SpecDecomposition {
  title: string;
  summary: string;
  tasks: SpecDecompositionTask[];
  unknowns: string[];
  risks: string[];
  firstTaskNote: string;
}

export interface ProposeImportSpecInput {
  /** Operator-supplied title hint. May be empty. */
  title: string;
  /** The full spec markdown, verbatim. */
  specMarkdown: string;
  ceremony: Ceremony;
  role: Role;
}

export interface ProposeImportSpecOptions {
  agentInvoker?: (prompt: string) => Promise<InvokeClaudeResult>;
  budgetSeconds?: number;
}

export interface ProposeImportSpecResult {
  decomposition: SpecDecomposition;
  /** Token + cost metrics from the agent invocation, if available. */
  metrics: import("@factory/runtime").AgentMetrics | null;
}

/**
 * Run the spec-decompose agent against the operator's spec. Returns a draft
 * decomposition for the operator to review (and optionally edit) before
 * confirmation. No DB rows are created at this stage — the propose call is
 * pure compute. Confirmation is a separate mutation that takes the
 * (possibly edited) decomposition and bootstraps the project.
 */
export async function proposeImportSpec(
  db: Db,
  input: ProposeImportSpecInput,
  opts: ProposeImportSpecOptions = {},
): Promise<ProposeImportSpecResult> {
  if (input.specMarkdown.trim().length < 20) {
    throw new Error("spec too short — paste the full spec or upload a file");
  }

  const promptRow = await db
    .select()
    .from(schema.prompts)
    .where(
      and(eq(schema.prompts.promptKey, SPEC_DECOMPOSE_PROMPT_KEY), eq(schema.prompts.active, true)),
    )
    .get();
  if (!promptRow) {
    throw new Error(`no active prompt for ${SPEC_DECOMPOSE_PROMPT_KEY} — re-run \`bun run seed\`?`);
  }

  const rendered = renderTemplate(promptRow.content, {
    TITLE: input.title.trim(),
    INTENT_CEREMONY: input.ceremony,
    INTENT_ROLE: input.role,
    SPEC_MARKDOWN: input.specMarkdown,
  });

  const budget = opts.budgetSeconds ?? getAgentBudgetSeconds();
  const agent = resolveAgent(db);
  const invocation = opts.agentInvoker
    ? await opts.agentInvoker(rendered)
    : await invokeClaudeJson(rendered, { budgetSeconds: budget, agent });

  const parsed = extractJsonObject<Record<string, unknown>>(invocation.text);
  const metrics = invocation.metrics ?? null;

  // Record propose-cost so the metrics view reflects spec-import usage.
  // The owner-id is synthesized — there's no persistent row for the
  // propose call (no idea/decision/project rows are created until
  // `confirmImportSpec`). The (ownerKind, ownerId) pair is unique by
  // construction so the index is happy.
  if (metrics) {
    await recordClaudeMetrics({
      db,
      ownerKind: "spec_import",
      ownerId: createId(),
      projectId: null,
      metrics,
    });
  }

  return {
    decomposition: coerceDecomposition(parsed, input.title),
    metrics,
  };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

function coerceDecomposition(
  obj: Record<string, unknown>,
  fallbackTitle: string,
): SpecDecomposition {
  const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  return {
    title:
      typeof obj.title === "string" && obj.title.trim().length > 0
        ? obj.title.trim()
        : fallbackTitle.trim() || "imported-project",
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
    firstTaskNote: typeof obj.firstTaskNote === "string" ? obj.firstTaskNote : "",
  };
}

export interface ConfirmImportSpecInput {
  /** Operator-supplied title (echoed if provided, else from decomposition). */
  title: string;
  /** Full spec markdown, written verbatim to docs/internal/SPEC.md. */
  specMarkdown: string;
  /** Possibly-edited decomposition the operator confirmed. */
  decomposition: SpecDecomposition;
  ceremony: Ceremony;
  role: Role;
  /** Optional Claude model override; null = CLI default. */
  model: string | null;
}

export interface ConfirmImportSpecResult extends BootstrapResult {
  /** Repo-relative path of the spec file that was committed. */
  specPath: string;
}

/**
 * Bootstrap a project from a confirmed spec import. Synthesizes a
 * (greenlit, no rubric) idea + decision pair so downstream code that
 * expects projects to carry an `ideaId` works uniformly. Then writes
 * `docs/internal/SPEC.md` verbatim into the project repo, references it
 * from a bootstrap AGENTS.md (with CLAUDE.md as a symlink so Claude
 * Code's auto-loader still finds it), and amends the bootstrap commit
 * so all the onboarding artifacts land together.
 *
 * Auto-advance is on by default for fresh projects (matches existing
 * bootstrap behavior). The first ready task starts as soon as the
 * operator opens the project page or hits "run."
 */
export async function confirmImportSpec(
  config: FactoryConfig,
  db: Db,
  input: ConfirmImportSpecInput,
): Promise<ConfirmImportSpecResult> {
  if (input.specMarkdown.trim().length < 20) {
    throw new Error("spec too short — paste the full spec or upload a file");
  }

  const now = Date.now();

  // 1. Synthesize an idea row. Mark triagedAt = now since we're skipping
  // the triage scoring pass entirely. rawText preserves the operator's
  // title + spec for audit / replay.
  const ideaId = createId();
  const titleSuggestion = input.title.trim() || input.decomposition.title || "imported-project";
  const ideaRawText = input.title.trim()
    ? `${input.title.trim()}\n\n${input.specMarkdown}`
    : input.specMarkdown;
  await db.insert(schema.ideas).values({
    id: ideaId,
    rawText: ideaRawText,
    intentCeremony: input.ceremony,
    intentRole: input.role,
    source: "spec-import",
    createdAt: now,
    triagedAt: now,
  });

  // 2. Synthesize a greenlit decision. rubricVersionId stays null —
  // spec-import skips scoring entirely. The payload is shaped like a
  // standard TriageDecisionPayload so existing readers (bootstrap,
  // decision-detail UI) work unchanged.
  const decisionId = createId();
  const payload: TriageDecisionPayload = {
    outcome: "greenlit",
    rationale: `Imported spec — ${input.decomposition.summary || "(no summary)"}`,
    title_suggestion: titleSuggestion,
    spec_stub: {
      summary: input.decomposition.summary,
      initial_tasks: input.decomposition.tasks.map((t) => ({
        title: t.title,
        estimate: t.estimate,
        acceptance: t.acceptance,
      })),
    },
  };
  await db.insert(schema.decisions).values({
    id: decisionId,
    kind: "triage",
    ideaId,
    rubricVersionId: null,
    outcome: "greenlit",
    payload,
    status: "actioned",
    createdAt: now,
    actionedAt: now,
  });

  // 3. Bootstrap the project on disk + DB. Existing bootstrap creates
  // the .factory/ skeleton, initial task files, README, and the
  // bootstrap commit.
  const bootstrap = await bootstrapProject(config, db, {
    ideaId,
    decisionId,
    payload,
    ideaText: ideaRawText,
    ceremony: input.ceremony,
    role: input.role,
    model: input.model,
  });

  // 4. Write the spec verbatim + an AGENTS.md reference, then commit on
  // top of the bootstrap commit. Bootstrap doesn't generate either
  // instruction file, so we write AGENTS.md from scratch and drop a
  // CLAUDE.md symlink pointing at it for Claude Code's auto-loader.
  const specRelPath = path.posix.join("docs", "internal", "SPEC.md");
  const specAbsDir = path.join(bootstrap.workdirPath, "docs", "internal");
  await mkdir(specAbsDir, { recursive: true });
  await writeFile(
    path.join(bootstrap.workdirPath, "docs", "internal", "SPEC.md"),
    ensureTrailingNewline(input.specMarkdown),
    "utf8",
  );

  await ensureAgentsMdReferences({
    workdirPath: bootstrap.workdirPath,
    projectName: titleSuggestion,
    specPath: specRelPath,
    firstTaskNote: input.decomposition.firstTaskNote,
  });
  await ensureClaudeMdSymlink(bootstrap.workdirPath);

  await commitAllChanges(
    bootstrap.workdirPath,
    `docs: import operator spec to ${specRelPath}`,
    config.gitAuthor,
  );

  return { ...bootstrap, specPath: specRelPath };
}

const AGENTS_MD_HEADER = (projectName: string, specPath: string, firstTaskNote: string): string =>
  `# ${projectName} — agent operating manual

This project was bootstrapped from an operator-supplied spec via Factory's
spec-import path. Triage / scoring was skipped — the operator already knew
what they wanted.

## Read this first

- **${specPath}** — the operator's spec, verbatim. This is your source of
  truth. Where the spec is silent, prefer conservative defaults and
  surface the gap as a \`factory-decision\` block (see the decision
  protocol footer in your run prompt).
- **\`.factory/work/\`** — task files. Each carries acceptance criteria
  drawn from the spec.

${firstTaskNote ? `## First-task orientation\n\n${firstTaskNote}\n\n` : ""}## Doctrine

- Match work to ceremony. The spec named one — don't escalate or
  de-escalate it.
- The operator is not at the keyboard during runs. Use the
  factory-status / factory-decision protocols (taught in the run
  prompt's footer) to communicate — never block on stdin.
`;

async function ensureAgentsMdReferences(args: {
  workdirPath: string;
  projectName: string;
  specPath: string;
  firstTaskNote: string;
}): Promise<void> {
  const filePath = agentsMdPath(args.workdirPath);
  if (!existsSync(filePath)) {
    await writeFile(
      filePath,
      AGENTS_MD_HEADER(args.projectName, args.specPath, args.firstTaskNote),
      "utf8",
    );
    return;
  }
  // AGENTS.md exists (rare on a fresh bootstrap, but possible if the
  // operator's flow changes) — append a SPEC.md reference if missing.
  const existing = await readFile(filePath, "utf8");
  if (!existing.includes(args.specPath)) {
    const note = `\n## Spec\n\n- **${args.specPath}** — the operator-supplied spec for this project.\n`;
    const next = existing.endsWith("\n") ? `${existing}${note}` : `${existing}\n${note}`;
    await writeFile(filePath, next, "utf8");
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}
