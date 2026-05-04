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
import { renderTaskMarkdown } from "./tasks.ts";

export interface BootstrapInput {
  ideaId: string;
  decisionId: string;
  payload: TriageDecisionPayload;
  ideaText: string;
  goal: "me" | "learn" | "share" | "productize";
  tier: "tinker" | "personal" | "share" | "productize";
  /** Claude model id stored on the project; runs in this project will use it. */
  model?: string | null;
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
        goal: input.goal,
        tier: input.tier,
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

    // .factory/quality.yaml — seeded with a conservative default set. The
    // operator can edit or delete it; absence means "no quality checks for
    // this project" (v0.1 behavior preserved). We seed unconditionally for
    // new projects since every project bootstrap is Bun-based and at least
    // a typecheck pass is universally useful.
    await writeFile(
      path.join(workdirPath, ".factory", "quality.yaml"),
      `# Factory quality checks. Each command runs in the run's worktree
# after the agent declares done and before the merge into main.
# Failures are informational in v0.2 (do not block merge).
checks:
  - name: typecheck
    command: bun run typecheck
    timeoutSeconds: 300
  - name: lint
    command: bun run check
    timeoutSeconds: 120
  - name: test
    command: bun test
    timeoutSeconds: 600
`,
      "utf8",
    );

    // root .gitignore
    await writeFile(
      path.join(workdirPath, ".gitignore"),
      "worktrees/\n.factory/runs/\nnode_modules/\ndist/\n",
      "utf8",
    );

    // Initial task files from the spec_stub.
    const taskIds: string[] = [];
    const initialTasks = input.payload.spec_stub?.initial_tasks ?? [];
    for (let i = 0; i < initialTasks.length; i++) {
      const t = initialTasks[i];
      if (!t) continue;
      const id = `task-${String(i + 1).padStart(3, "0")}`;
      taskIds.push(id);
      const fileName = `${id}-${slugify(t.title || "untitled").slice(0, 40)}.md`;
      const acceptance = (t.acceptance ?? []).map((a) => `- [ ] ${a}`).join("\n");
      const md = renderTaskMarkdown({
        id,
        filePath: "",
        frontmatter: {
          id,
          title: t.title || "Untitled",
          status: "ready",
          priority: "med",
          created: new Date(now).toISOString(),
          updated: new Date(now).toISOString(),
          estimate: t.estimate ?? "small",
        },
        body: `## Acceptance\n\n${acceptance || "- [ ] (TBD)"}\n\n## Notes\n\n(agent-maintained)\n`,
      });
      await writeFile(path.join(workdirPath, ".factory", "work", fileName), md, "utf8");
    }

    // README seed.
    await writeFile(
      path.join(workdirPath, "README.md"),
      `# ${input.payload.title_suggestion ?? slug}\n\n${input.payload.spec_stub?.summary ?? input.ideaText}\n`,
      "utf8",
    );

    await git(["add", "-A"], workdirPath);
    await git(["commit", "-q", "-m", "chore: factory bootstrap"], workdirPath);

    await db.insert(schema.projects).values({
      id: projectId,
      slug,
      name: input.payload.title_suggestion ?? titleHint.slice(0, 80),
      ideaId: input.ideaId,
      goal: input.goal,
      tier: input.tier,
      tag: "active",
      workdirPath,
      createdAt: now,
      lastActivityAt: now,
      model: input.model ?? null,
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
