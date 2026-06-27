import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type RefinementDraft, runMigrations, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { spawn as bunSpawn } from "bun";
import type { FactoryConfig } from "../src/config.ts";
import { applyRefinementFreeze } from "../src/plans/refine.ts";
import { createTask, readTaskFile } from "../src/projects/tasks.ts";

interface Harness {
  config: FactoryConfig;
  db: ReturnType<typeof createDb>;
  root: string;
  workdirPath: string;
  projectId: string;
  cleanup: () => void;
}

async function git(args: string[], cwd: string): Promise<string> {
  const proc = bunSpawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}

async function setupHarness(): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "factory-plans-refine-"));
  const dbPath = path.join(root, "data.db");
  const projectsRoot = path.join(root, "projects");
  const worktreesRoot = path.join(root, "worktrees");
  const workdirPath = path.join(projectsRoot, "demo");
  mkdirSync(path.join(workdirPath, ".factory", "work"), { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  await git(["init", "-q", "-b", "main"], workdirPath);
  await git(["config", "user.name", "Test"], workdirPath);
  await git(["config", "user.email", "test@test"], workdirPath);

  runMigrations(dbPath);
  const db = createDb(dbPath);
  const projectId = createId();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "demo",
    name: "Demo",
    ceremony: "personal",
    role: "owner",
    workdirPath,
    createdAt: now,
    lastActivityAt: now,
  });

  const config: FactoryConfig = {
    port: 0,
    host: "127.0.0.1",
    auth: { token: "t" },
    workdir: projectsRoot,
    worktreesRoot,
    dbPath,
    maxConcurrentRuns: 1,
    defaultRunBudgetSeconds: 60,
    agentBudgetSeconds: 0,
    gitAuthor: { name: "Test", email: "test@test" },
    githubToken: null,
    githubApp: null,
    factoryProjectId: null,
    githubReplyAllowlist: [],
    publicBaseUrl: null,
    notifyOnRunComplete: false,
    vapid: { publicKey: "", privateKey: "", subject: "mailto:test@test" },
  };

  return {
    config,
    db,
    root,
    workdirPath,
    projectId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function commitBaseline(workdirPath: string): Promise<void> {
  await git(["add", "-A"], workdirPath);
  await git(["commit", "-q", "-m", "initial"], workdirPath);
}

describe("applyRefinementFreeze", () => {
  test.each([
    "done",
    "review",
  ] as const)("re-opens a %s task when revised acceptance is frozen", async (status) => {
    const h = await setupHarness();
    try {
      const task = await createTask(
        { workdirPath: h.workdirPath },
        {
          title: "Correct completed work",
          status,
          body: "## Acceptance\n\n- [ ] old criterion\n\n## Notes\n\nOriginal notes.\n",
        },
      );
      await commitBaseline(h.workdirPath);

      const draft: RefinementDraft = {
        kind: "refinement",
        targetTaskId: task.id,
        feedback: "The acceptance criteria need the corrected outcome.",
        revisedAcceptance: ["new criterion", "second corrected criterion"],
      };
      const result = await applyRefinementFreeze({
        config: h.config,
        db: h.db,
        projectId: h.projectId,
        taskId: task.id,
        planId: createId(),
        draft,
      });

      const updated = await readTaskFile({ workdirPath: h.workdirPath }, task.id);
      expect(result).toEqual({
        rewroteAcceptance: true,
        reopenedTask: true,
        followupTaskIds: [],
      });
      expect(updated?.frontmatter.status).toBe("ready");
      expect(updated?.body).toContain("- [ ] new criterion");
      expect(updated?.body).toContain("## Notes\n\nOriginal notes.");
      const subject = (await git(["log", "-1", "--pretty=%s"], h.workdirPath)).trim();
      expect(subject).toContain(`revised acceptance for ${task.id}`);
      expect(subject).toContain("re-opened task");
    } finally {
      h.cleanup();
    }
  });

  test("does not re-open followups-only refinements", async () => {
    const h = await setupHarness();
    try {
      const task = await createTask(
        { workdirPath: h.workdirPath },
        {
          title: "Keep completed task closed",
          status: "done",
          body: "## Acceptance\n\n- [ ] keep existing criterion\n",
        },
      );
      await commitBaseline(h.workdirPath);

      const draft: RefinementDraft = {
        kind: "refinement",
        targetTaskId: task.id,
        feedback: "Add a follow-up without changing this task.",
        followups: [{ title: "Follow-up task", estimate: "small" }],
      };
      const result = await applyRefinementFreeze({
        config: h.config,
        db: h.db,
        projectId: h.projectId,
        taskId: task.id,
        planId: createId(),
        draft,
      });

      const updated = await readTaskFile({ workdirPath: h.workdirPath }, task.id);
      expect(result.rewroteAcceptance).toBe(false);
      expect(result.reopenedTask).toBe(false);
      expect(result.followupTaskIds).toEqual(["task-002"]);
      expect(updated?.frontmatter.status).toBe("done");
      const subject = (await git(["log", "-1", "--pretty=%s"], h.workdirPath)).trim();
      expect(subject).toContain("+1 follow-up(s)");
      expect(subject).not.toContain("re-opened task");
    } finally {
      h.cleanup();
    }
  });
});
