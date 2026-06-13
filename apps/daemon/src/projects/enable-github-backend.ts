import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import {
  githubAppClientFromConfig,
  parseGithubRepo,
  resolveBotGitAuthor,
} from "../github/app-auth.ts";
import { GithubIssuesStore } from "./github-task-store.ts";
import { FileTaskStore } from "./tasks.ts";

export interface EnableGithubBackendResult {
  migrated: number;
  installationId: number;
}

/** Move `.factory/work/*.md` into `.factory/work/.migrated/` — preserved, not deleted. */
async function archiveTaskFiles(workdirPath: string): Promise<void> {
  const dir = path.join(workdirPath, ".factory", "work");
  if (!existsSync(dir)) return;
  const archive = path.join(dir, ".migrated");
  await mkdir(archive, { recursive: true });
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".md")) continue;
    await rename(path.join(dir, entry), path.join(archive, entry));
  }
}

/**
 * Flip a project to the GitHub Issues task backend (ADR-007 Phase 2b): backfill
 * every existing file task as an issue (preserving its old id as `legacy_id`
 * and its status), archive the local files, and record the backend + cached
 * installation id on the project row.
 *
 * Idempotency / safety: refuses if the repo already carries Factory-labeled
 * issues (avoids double-backfill on a re-run after a partial failure). The
 * backend flip happens before archiving so a crash never leaves the project
 * reading an empty local dir.
 */
export async function enableGithubIssuesBackend(
  deps: { db: Db; config: FactoryConfig },
  projectId: string,
): Promise<EnableGithubBackendResult> {
  const { db, config } = deps;
  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) throw new Error(`project not found: ${projectId}`);
  if (project.taskBackend === "github-issues") {
    return { migrated: 0, installationId: project.githubInstallationId ?? 0 };
  }
  if (!project.githubRemote) {
    throw new Error("project has no GitHub remote — publish or import a GitHub repo first");
  }
  const client = githubAppClientFromConfig(config);
  if (!client) throw new Error("the Factory GitHub App is not configured");
  const repo = parseGithubRepo(project.githubRemote);
  if (!repo) throw new Error(`could not parse owner/repo from ${project.githubRemote}`);

  const installationId = await client.installationId(repo.owner, repo.repo);
  const store = new GithubIssuesStore(client, repo.owner, repo.repo, installationId);

  const existing = await store.list();
  if (existing.length > 0) {
    throw new Error(
      `${repo.owner}/${repo.repo} already has ${existing.length} factory-labeled issue(s) — resolve or remove them before enabling the backend`,
    );
  }

  const files = await new FileTaskStore(project.workdirPath).list();
  for (const f of files) {
    await store.importTask(f);
  }

  // Flip the backend first: reads now resolve to the issues we just created.
  await db
    .update(schema.projects)
    .set({ taskBackend: "github-issues", githubInstallationId: installationId })
    .where(eq(schema.projects.id, projectId));

  await archiveTaskFiles(project.workdirPath);
  const botAuthor = await resolveBotGitAuthor(config, project.githubRemote);
  await commitAllChanges(
    project.workdirPath,
    `chore: migrate ${files.length} task(s) to github issues`,
    botAuthor ?? config.gitAuthor,
  );

  return { migrated: files.length, installationId };
}
