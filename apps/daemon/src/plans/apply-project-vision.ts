import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db, ProjectVisionDraft } from "@factory/db";
import { schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";

export interface ApplyProjectVisionInput {
  config: FactoryConfig;
  db: Db;
  projectId: string;
  draft: ProjectVisionDraft;
  planId: string;
}

export interface ApplyProjectVisionResult {
  visionPath: string;
  claudeMdUpdated: boolean;
}

/**
 * Apply a frozen project_vision plan: write `docs/internal/VISION.md` and
 * (on first authoring) drop a small reference into CLAUDE.md so the agent
 * knows where to look.
 *
 * The reference in CLAUDE.md is small and self-explanatory — Factory does
 * not auto-prepend VISION.md to run prompts. The agent reads CLAUDE.md as
 * its operating manual and follows the reference there.
 */
export async function applyProjectVisionFreeze(
  input: ApplyProjectVisionInput,
): Promise<ApplyProjectVisionResult> {
  const { config, db, projectId, draft, planId } = input;
  if (draft.kind !== "project_vision") {
    throw new Error(`applyProjectVisionFreeze called with non-project_vision draft: ${draft.kind}`);
  }
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) throw new Error(`project ${projectId} not found`);

  const visionDir = path.join(project.workdirPath, "docs", "internal");
  await mkdir(visionDir, { recursive: true });
  const visionPath = path.join(visionDir, "VISION.md");
  const md = renderVisionMarkdown(draft, project.name, planId);
  await writeFile(visionPath, md, "utf8");

  const claudeMdPath = path.join(project.workdirPath, "CLAUDE.md");
  const reference =
    "- **VISION.md** lives at `docs/internal/VISION.md` — read it before any non-trivial change. It states identity, principles, phases, and out-of-scope items.";
  let claudeMdUpdated = false;
  if (existsSync(claudeMdPath)) {
    const existing = await readFile(claudeMdPath, "utf8");
    if (!existing.includes("docs/internal/VISION.md")) {
      const next = existing.endsWith("\n")
        ? `${existing}\n${reference}\n`
        : `${existing}\n\n${reference}\n`;
      await writeFile(claudeMdPath, next, "utf8");
      claudeMdUpdated = true;
    }
  } else {
    // Bootstrap a minimal CLAUDE.md if missing (rare — bootstrap usually
    // creates it). Operator can flesh it out later.
    await writeFile(claudeMdPath, `# ${project.name}\n\n## Doctrine\n\n${reference}\n`, "utf8");
    claudeMdUpdated = true;
  }

  await commitAllChanges(
    project.workdirPath,
    `docs: add project vision (factory plan #${planId.slice(0, 8)})`,
    config.gitAuthor,
  );

  return { visionPath: "docs/internal/VISION.md", claudeMdUpdated };
}

function renderVisionMarkdown(
  draft: ProjectVisionDraft,
  projectName: string,
  planId: string,
): string {
  const principles = draft.designPrinciples.map((p) => `- **${p.name}.** ${p.meaning}`).join("\n");
  const outOfScope = draft.outOfScope.map((o) => `- ${o}`).join("\n");
  const roadmap = draft.roadmap
    .map((r) => `### ${r.phase}\n\n${r.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n\n");
  const priorArt = draft.priorArt.map((a) => `- ${a}`).join("\n");
  const personalityBlock = draft.personality ? `\n## Personality\n\n${draft.personality}\n` : "";

  return `# ${projectName} — Vision

> Authored by Factory plan \`#${planId.slice(0, 8)}\`. Edits welcome — this
> is a checked-in document like any other.

## Identity

${draft.identity || "(unspecified)"}

## Audience

${draft.audience || "(unspecified)"}

## Problem

${draft.problem || "(unspecified)"}

## Design principles

${principles || "(none)"}

## Out of scope

${outOfScope || "(none)"}
${personalityBlock}
## Roadmap

${roadmap || "(none)"}

## Prior art

${priorArt || "(none)"}
`;
}
