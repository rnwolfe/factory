import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import YAML from "yaml";
import type { FactoryConfig } from "../config.ts";
import type { TriageDecisionPayload } from "../triage/orchestrate.ts";
import { DEFAULT_MAKEFILE, DEFAULT_QUALITY_YAML } from "./quality-config.ts";
import { applyDependsOnEdges, createTask, renderAcceptanceBlock, type TaskFile } from "./tasks.ts";

export interface BootstrapInput {
  ideaId: string;
  decisionId: string;
  payload: TriageDecisionPayload;
  ideaText: string;
  ceremony: "tinker" | "personal" | "shared" | "production";
  role: "owner" | "contributor";
  /** SPDX license id, or null. Drives README scaffolding for shared/production. */
  license?: string | null;
  /** Claude model id stored on the project; runs in this project will use it. */
  model?: string | null;
  /**
   * Milestone id to tag the initial task batch with (e.g. `"M0"`), when the spec
   * is milestone-structured. Omitted for flat specs / triage-origin projects.
   */
  milestone?: string;
}

export interface BootstrapResult {
  projectId: string;
  slug: string;
  workdirPath: string;
  taskIds: string[];
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

export async function bootstrapProject(
  config: FactoryConfig,
  db: Db,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const titleHint = input.payload.title_suggestion ?? input.ideaText;
  const baseSlug = slugify(titleHint || `project-${Date.now()}`);
  const slug = await pickUniqueSlug(db, baseSlug);

  const projectsRoot = path.join(config.workdir, "projects");
  const workdirPath = path.join(projectsRoot, slug);

  if (existsSync(workdirPath)) {
    throw new Error(`project path already exists: ${workdirPath}`);
  }

  // Atomic-ish: build everything, then write DB row. On failure, remove dir.
  const cleanup = async () => {
    try {
      await rm(workdirPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    await mkdir(path.join(workdirPath, ".factory", "work"), { recursive: true });
    await mkdir(path.join(workdirPath, ".factory", "notes"), { recursive: true });

    await git(["init", "-q", "-b", "main"], workdirPath);
    await git(["config", "user.name", config.gitAuthor.name], workdirPath);
    await git(["config", "user.email", config.gitAuthor.email], workdirPath);

    const projectId = createId();
    const now = Date.now();

    // .factory/meta.yaml
    await writeFile(
      path.join(workdirPath, ".factory", "meta.yaml"),
      YAML.stringify({
        projectId,
        slug,
        ideaId: input.ideaId,
        decisionId: input.decisionId,
        ceremony: input.ceremony,
        role: input.role,
        license: input.license ?? null,
        created: new Date(now).toISOString(),
      }),
      "utf8",
    );

    // .factory/notes/decisions.md
    await writeFile(
      path.join(workdirPath, ".factory", "notes", "decisions.md"),
      `# Project Decisions\n\n## Bootstrap (${new Date(now).toISOString()})\n\nProject created from idea ${input.ideaId} via decision ${input.decisionId}.\n\nIdea text:\n\n> ${input.ideaText.replace(/\n/g, "\n> ")}\n\n${
        input.payload.spec_stub?.summary ? `Spec stub: ${input.payload.spec_stub.summary}\n` : ""
      }`,
      "utf8",
    );

    // .factory/.gitignore
    await writeFile(path.join(workdirPath, ".factory", ".gitignore"), "runs/\n", "utf8");

    // .factory/quality.yaml + Makefile — the project's quality interface.
    // Quality checks delegate to `make` targets rather than hard-coding a
    // package manager: bootstrap runs before any project code exists, so it
    // cannot know the stack, and real projects are often polyglot (a TS web
    // app plus a Python worker, say). The Makefile is the per-project adapter
    // the agent fills in as it builds. Templates + the migration for projects
    // bootstrapped before this interface live in quality-config.ts. The
    // operator can edit or delete quality.yaml; absence means "no checks."
    await writeFile(
      path.join(workdirPath, ".factory", "quality.yaml"),
      DEFAULT_QUALITY_YAML,
      "utf8",
    );
    await writeFile(path.join(workdirPath, "Makefile"), DEFAULT_MAKEFILE, "utf8");

    // root .gitignore
    await writeFile(
      path.join(workdirPath, ".gitignore"),
      "worktrees/\n.factory/runs/\nnode_modules/\ndist/\n",
      "utf8",
    );

    // Initial task files from the spec_stub. Routes through tasks.createTask
    // so the storage seam stays single-pointed (per ADR-003 §10.1).
    const initialTasks = input.payload.spec_stub?.initial_tasks ?? [];
    const createdTasks: TaskFile[] = [];
    for (const t of initialTasks) {
      if (!t) continue;
      createdTasks.push(
        await createTask(
          { workdirPath },
          {
            title: t.title || "Untitled",
            body: `## Acceptance\n\n${renderAcceptanceBlock(t.acceptance)}\n\n## Notes\n\n(agent-maintained)\n`,
            estimate: t.estimate ?? "small",
            priority: "med",
            ...(input.milestone ? { milestone: input.milestone } : {}),
          },
        ),
      );
    }
    // Resolve model-declared intra-batch ordering into blockedBy edges (ADR-019 §5).
    await applyDependsOnEdges(
      { workdirPath },
      createdTasks,
      initialTasks.filter(Boolean).map((t) => t?.dependsOn),
    );
    const taskIds = createdTasks.map((c) => c.id);

    // README seed.
    await writeFile(
      path.join(workdirPath, "README.md"),
      `# ${input.payload.title_suggestion ?? slug}\n\n${input.payload.spec_stub?.summary ?? input.ideaText}\n`,
      "utf8",
    );

    await git(["add", "-A"], workdirPath);
    await git(["commit", "-q", "-m", "chore: factory bootstrap"], workdirPath);

    // Tinker projects default to `autonomous` — minimal ceremony, agent
    // makes its own calls and notes them in the summary. Everything else
    // defaults to `collaborative` so meaningful architectural choices
    // surface in the operator's inbox. Operator can flip from the
    // project header.
    const autonomyMode: "collaborative" | "autonomous" =
      input.ceremony === "tinker" ? "autonomous" : "collaborative";

    await db.insert(schema.projects).values({
      id: projectId,
      slug,
      name: input.payload.title_suggestion ?? titleHint.slice(0, 80),
      ideaId: input.ideaId,
      ceremony: input.ceremony,
      role: input.role,
      license: input.license ?? null,
      tag: "active",
      workdirPath,
      createdAt: now,
      lastActivityAt: now,
      model: input.model ?? null,
      autonomyMode,
    });

    return { projectId, slug, workdirPath, taskIds };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function pickUniqueSlug(db: Db, base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  while (true) {
    const all = await db.select({ slug: schema.projects.slug }).from(schema.projects).all();
    const taken = new Set(all.map((r) => r.slug));
    if (!taken.has(candidate)) return candidate;
    suffix++;
    candidate = `${base}-${suffix}`;
    if (suffix > 999) throw new Error("could not allocate unique slug");
  }
}
