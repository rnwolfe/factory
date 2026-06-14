import { schema } from "@factory/db";
import { commitAllChanges } from "@factory/runtime";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { enableGithubIssuesBackend } from "../projects/enable-github-backend.ts";
import { createRepo, GithubError, pushToNewRemote } from "../projects/github.ts";
import { replyAsOperator, taskThread } from "../projects/github-task-store.ts";
import {
  ImportError,
  importFromPath,
  importFromUrl,
  readGithubOriginRemote,
} from "../projects/import.ts";
import {
  type ConfirmImportSpecInput,
  confirmImportSpec,
  proposeImportSpec,
  type SpecDecomposition,
} from "../projects/import-spec.ts";
import {
  archiveProject,
  deleteProject,
  LifecycleError,
  previewDelete,
  unarchiveProject,
} from "../projects/lifecycle.ts";
import {
  createTask,
  listTasks,
  readTaskFile,
  renderAcceptanceBlock,
  updateTaskAgent,
  updateTaskBody,
  updateTaskModel,
  updateTaskStatus,
} from "../projects/tasks.ts";
import { snapshotWorkdir } from "../projects/workdir.ts";
import { protectedProcedure, router } from "../trpc.ts";

const TagEnum = z.enum(["active", "background", "past"]);
const CeremonyEnum = z.enum(["tinker", "personal", "shared", "production"]);
const RoleEnum = z.enum(["owner", "contributor"]);
const TaskStatusEnum = z.enum(["ready", "in_progress", "review", "done", "blocked", "dropped"]);
const TaskEstimateEnum = z.enum(["small", "medium", "large"]);
const TaskPriorityEnum = z.enum(["low", "med", "high"]);
const AutonomyModeEnum = z.enum(["collaborative", "autonomous"]);

const tasksRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) return [];
      const tasks = await listTasks(project);
      return tasks.map((t) => t.frontmatter);
    }),
  get: protectedProcedure
    .input(z.object({ projectId: z.string(), taskId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) return null;
      const task = await readTaskFile(project, input.taskId);
      if (!task) return null;
      return { frontmatter: task.frontmatter, body: task.body, projectAgent: project.agent };
    }),
  updateStatus: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        status: TaskStatusEnum,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const updated = await updateTaskStatus(project, input.taskId, input.status);
      if (!updated) throw new Error("task not found");
      // Commit on main so the next run's worktree starts clean. Without this,
      // operator-driven status flips dirty the project tree and the next
      // mergeIntoMain refuses ("project working tree has uncommitted changes").
      await commitAllChanges(
        project.workdirPath,
        `chore: ${input.taskId} status -> ${input.status}`,
        ctx.config.gitAuthor,
      );
      return updated.frontmatter;
    }),
  updateBody: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        body: z.string().max(50_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const updated = await updateTaskBody(project, input.taskId, input.body);
      if (!updated) throw new Error("task not found");
      await commitAllChanges(
        project.workdirPath,
        `docs: ${input.taskId} body update`,
        ctx.config.gitAuthor,
      );
      return { frontmatter: updated.frontmatter, body: updated.body };
    }),
  updateModel: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        // Empty string clears the per-task override (falls back to project
        // default at submit time). Any non-empty value pins the task to
        // that model id verbatim.
        model: z.string().max(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const updated = await updateTaskModel(project, input.taskId, input.model);
      if (!updated) throw new Error("task not found");
      await commitAllChanges(
        project.workdirPath,
        `chore: ${input.taskId} model -> ${input.model || "default"}`,
        ctx.config.gitAuthor,
      );
      return updated.frontmatter;
    }),
  updateAgent: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        // Empty string clears the per-task override (falls back to project
        // default at submit time). Non-empty values are constrained to the
        // supported harnesses because submit ignores unknown task agents.
        agent: z.enum(["claude-code", "codex"]).or(z.literal("")),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const updated = await updateTaskAgent(project, input.taskId, input.agent);
      if (!updated) throw new Error("task not found");
      await commitAllChanges(
        project.workdirPath,
        `chore: ${input.taskId} agent -> ${input.agent || "default"}`,
        ctx.config.gitAuthor,
      );
      return updated.frontmatter;
    }),
  /**
   * Create a task directly (no plan freeze required). Used by audit-finding
   * promotion (bug path), the PWA "+ task" button, and any other ad-hoc
   * capture path. Routes through tasks.createTask so the storage seam stays
   * single-pointed.
   */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        title: z.string().min(1).max(200),
        body: z.string().max(50_000).optional(),
        labels: z.array(z.string().max(40)).max(20).optional(),
        parent: z.string().max(40).optional(),
        estimate: TaskEstimateEnum.optional(),
        priority: TaskPriorityEnum.optional(),
        model: z.string().max(120).optional(),
        agent: z.enum(["claude-code", "codex"]).optional(),
        acceptance: z.array(z.string().max(500)).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      const body =
        input.body ??
        `## Acceptance\n\n${renderAcceptanceBlock(input.acceptance)}\n\n## Notes\n\n(operator-captured)\n`;
      const created = await createTask(project, {
        title: input.title,
        body,
        labels: input.labels,
        parent: input.parent,
        estimate: input.estimate,
        priority: input.priority,
        model: input.model,
        agent: input.agent,
      });
      await commitAllChanges(
        project.workdirPath,
        `chore: capture ${created.id} — ${input.title.slice(0, 60)}`,
        ctx.config.gitAuthor,
      );
      // Touch project lastActivityAt so the dashboard reflects the capture.
      await ctx.db
        .update(schema.projects)
        .set({ lastActivityAt: Date.now() })
        .where(eq(schema.projects.id, project.id));
      return { task: { frontmatter: created.frontmatter, body: created.body } };
    }),

  /** Issue comment thread for a github-backed task (read). Empty for file-backed. */
  thread: protectedProcedure
    .input(z.object({ projectId: z.string(), taskId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project || project.taskBackend !== "github-issues") {
        return { backend: project?.taskBackend ?? "file", comments: [] };
      }
      const comments = await taskThread(ctx.config, project, input.taskId);
      return { backend: "github-issues" as const, comments };
    }),

  /** Reply to a github-backed task's thread, authored as the operator (PAT). */
  reply: protectedProcedure
    .input(
      z.object({ projectId: z.string(), taskId: z.string(), body: z.string().min(1).max(50_000) }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new Error("project not found");
      if (project.taskBackend !== "github-issues") {
        throw new Error("project is not github-issues backed");
      }
      if (!ctx.config.githubToken) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Set a GitHub token in Settings to reply as yourself.",
        });
      }
      await replyAsOperator(ctx.config.githubToken, project, input.taskId, input.body);
      return { ok: true };
    }),
});

export const projectsRouter = router({
  list: protectedProcedure
    .input(z.object({ tag: TagEnum.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const where = input?.tag ? eq(schema.projects.tag, input.tag) : undefined;
      const q = ctx.db.select().from(schema.projects);
      const rows = await (where ? q.where(where) : q)
        .orderBy(desc(schema.projects.lastActivityAt))
        .all();

      // Per-row runtime activity: how many runs are queued/running for each
      // project. One aggregate query rather than N round-trips. Without this
      // the list shows only the operator-set workflow tag, which doesn't
      // tell the operator whether anything is actually happening right now.
      const activity = await ctx.db
        .select({
          projectId: schema.runs.projectId,
          running: sql<number>`SUM(CASE WHEN ${schema.runs.status} = 'running' THEN 1 ELSE 0 END)`,
          queued: sql<number>`SUM(CASE WHEN ${schema.runs.status} = 'queued' THEN 1 ELSE 0 END)`,
        })
        .from(schema.runs)
        .where(inArray(schema.runs.status, ["running", "queued"]))
        .groupBy(schema.runs.projectId)
        .all();
      const activityByProject = new Map<string, { running: number; queued: number }>();
      for (const a of activity) {
        activityByProject.set(a.projectId, {
          running: Number(a.running ?? 0),
          queued: Number(a.queued ?? 0),
        });
      }

      return rows.map((r) => {
        const a = activityByProject.get(r.id);
        return {
          ...r,
          runningRunCount: a?.running ?? 0,
          queuedRunCount: a?.queued ?? 0,
        };
      });
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const project = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, input.id))
      .get();
    if (!project) return null;

    // Reconcile githubRemote with the workdir's actual origin. The operator
    // can run `git remote add origin …` out of band, so we re-read on each
    // get. We only fill in missing/changed values — never clobber a stored
    // remote with a null read, since origin can be temporarily renamed or
    // unavailable while the operator is mid-edit.
    let reconciled = project;
    const liveRemote = await readGithubOriginRemote(project.workdirPath);
    if (liveRemote && liveRemote !== project.githubRemote) {
      await ctx.db
        .update(schema.projects)
        .set({ githubRemote: liveRemote })
        .where(eq(schema.projects.id, project.id));
      reconciled = { ...project, githubRemote: liveRemote };
    }

    const tasks = await listTasks(project);
    return { project: reconciled, tasks: tasks.map((t) => t.frontmatter) };
  }),

  tag: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        tag: TagEnum,
        note: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.id))
        .get();
      if (!project) throw new Error("project not found");

      const now = Date.now();
      await ctx.db
        .update(schema.projects)
        .set({ tag: input.tag, lastActivityAt: now })
        .where(eq(schema.projects.id, input.id));

      // Log a tag_change decision in actioned state — provides an audit trail
      // and surfaces in history.
      const decisionId = createId();
      await ctx.db.insert(schema.decisions).values({
        id: decisionId,
        kind: "tag_change",
        projectId: project.id,
        outcome: `tag:${input.tag}`,
        payload: { previousTag: project.tag, newTag: input.tag, note: input.note ?? null },
        status: "actioned",
        createdAt: now,
        actionedAt: now,
      });

      return { ok: true, tag: input.tag };
    }),

  setAutoAdvance: protectedProcedure
    .input(z.object({ id: z.string(), autoAdvance: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ autoAdvance: input.autoAdvance })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, autoAdvance: input.autoAdvance };
    }),

  setModel: protectedProcedure
    .input(z.object({ id: z.string(), model: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ model: input.model })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, model: input.model };
    }),

  setAgent: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        agent: z.enum(["claude-code", "codex"]).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ agent: input.agent })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, agent: input.agent };
    }),

  setCeremony: protectedProcedure
    .input(z.object({ id: z.string(), ceremony: CeremonyEnum }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ ceremony: input.ceremony })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, ceremony: input.ceremony };
    }),

  setRole: protectedProcedure
    .input(z.object({ id: z.string(), role: RoleEnum }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ role: input.role })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, role: input.role };
    }),

  /**
   * Toggle whether agent runs surface mid-flight architectural decisions
   * to the inbox. `autonomous` mutes the surface entirely (agent picks a
   * defensible path and notes it in run summary); `collaborative` lets
   * the agent emit `factory-decision` blocks for choices that meaningfully
   * affect public surface, library picks, or future-constraint patterns.
   * Default is `collaborative` for personal+, `autonomous` for tinker.
   */
  setAutonomyMode: protectedProcedure
    .input(z.object({ id: z.string(), autonomyMode: AutonomyModeEnum }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.projects)
        .set({ autonomyMode: input.autonomyMode })
        .where(eq(schema.projects.id, input.id));
      return { ok: true, autonomyMode: input.autonomyMode };
    }),

  workdir: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const project = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, input.id))
      .get();
    if (!project) return null;
    return snapshotWorkdir(project.workdirPath);
  }),

  /**
   * v0.4 cut 6 — bring an existing repo into Factory without going through
   * triage. URL mode clones into <workdir>/projects/<slug>; path mode adopts
   * an existing checkout in place. Either mode writes the .factory/
   * skeleton without clobbering existing files.
   */
  import: protectedProcedure
    .input(
      z.object({
        source: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("url"), url: z.string().url() }),
          z.object({ kind: z.literal("path"), path: z.string().min(1) }),
        ]),
        name: z.string().min(1).max(80).optional(),
        slug: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-z0-9-]+$/)
          .optional(),
        ceremony: CeremonyEnum.optional().default("tinker"),
        role: RoleEnum.optional().default("owner"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result =
          input.source.kind === "url"
            ? await importFromUrl(ctx.config, ctx.db, {
                url: input.source.url,
                name: input.name,
                slug: input.slug,
                ceremony: input.ceremony,
                role: input.role,
              })
            : await importFromPath(ctx.config, ctx.db, {
                workdirPath: input.source.path,
                name: input.name,
                slug: input.slug,
                ceremony: input.ceremony,
                role: input.role,
              });
        return result;
      } catch (err) {
        if (err instanceof ImportError) {
          // Map our typed errors to readable trpc errors so the PWA can show
          // a useful message in the form. clone_failed/clone_timeout are
          // user-actionable (private repo, bad URL, network); the rest are
          // bad input.
          const code =
            err.code === "clone_failed" || err.code === "clone_timeout"
              ? "INTERNAL_SERVER_ERROR"
              : "BAD_REQUEST";
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }
    }),

  /**
   * Spec-import fast lane: take an operator-supplied fully-drafted spec and
   * produce a task decomposition for review. Pure compute — no DB rows are
   * created. The operator reviews/edits the decomposition and then calls
   * `confirmImportSpec` to actually bootstrap the project.
   */
  proposeImportSpec: protectedProcedure
    .input(
      z.object({
        title: z.string().max(120).default(""),
        specMarkdown: z.string().min(20).max(200_000),
        ceremony: CeremonyEnum.default("personal"),
        role: RoleEnum.default("owner"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await proposeImportSpec(ctx.db, {
          title: input.title,
          specMarkdown: input.specMarkdown,
          ceremony: input.ceremony,
          role: input.role,
        });
        return { decomposition: result.decomposition };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
      }
    }),

  /**
   * Confirm + bootstrap: takes the (possibly edited) decomposition, the
   * verbatim spec, and project metadata. Synthesizes idea + greenlit
   * decision, calls bootstrapProject, writes docs/internal/SPEC.md, drops
   * a CLAUDE.md reference, and commits all of it on top of the bootstrap.
   * Auto-advance is on by default — first ready task starts immediately.
   */
  confirmImportSpec: protectedProcedure
    .input(
      z.object({
        title: z.string().max(120).default(""),
        specMarkdown: z.string().min(20).max(200_000),
        ceremony: CeremonyEnum.default("personal"),
        role: RoleEnum.default("owner"),
        model: z.string().nullable().default(null),
        decomposition: z.object({
          title: z.string().max(120),
          summary: z.string().max(4000),
          tasks: z
            .array(
              z.object({
                title: z.string().min(1).max(200),
                estimate: TaskEstimateEnum,
                acceptance: z.array(z.string().max(500)).max(20),
              }),
            )
            .min(1)
            .max(20),
          unknowns: z.array(z.string().max(500)).max(20),
          risks: z.array(z.string().max(500)).max(20),
          firstTaskNote: z.string().max(1000),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const confirmInput: ConfirmImportSpecInput = {
        title: input.title,
        specMarkdown: input.specMarkdown,
        ceremony: input.ceremony,
        role: input.role,
        model: input.model,
        decomposition: input.decomposition as SpecDecomposition,
      };
      try {
        const result = await confirmImportSpec(ctx.config, ctx.db, confirmInput);
        return {
          projectId: result.projectId,
          slug: result.slug,
          taskIds: result.taskIds,
          specPath: result.specPath,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
      }
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        archiveProject(ctx.db, input.id);
      } catch (err) {
        if (err instanceof LifecycleError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
      return { ok: true };
    }),

  unarchive: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        unarchiveProject(ctx.db, input.id);
      } catch (err) {
        if (err instanceof LifecycleError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
      return { ok: true };
    }),

  /** Compute a preview the operator sees in the typed-confirm modal. */
  previewDelete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        return await previewDelete(ctx.config, ctx.db, input.id);
      } catch (err) {
        if (err instanceof LifecycleError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),

  /**
   * Hard delete. The PWA must verify the operator typed the slug; the daemon
   * additionally requires the operator-supplied `slugConfirm` to match the
   * project row's slug as a defense-in-depth check.
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        slugConfirm: z.string(),
        removeWorkdir: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.id))
        .get();
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });
      }
      if (input.slugConfirm !== project.slug) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `confirm slug must match "${project.slug}"`,
        });
      }
      try {
        const result = await deleteProject(ctx.config, ctx.db, input.id, {
          removeWorkdir: input.removeWorkdir,
        });
        return result;
      } catch (err) {
        if (err instanceof LifecycleError) {
          const code = err.code === "running_run" ? "PRECONDITION_FAILED" : "NOT_FOUND";
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }
    }),

  /**
   * Daemon-side capability check for the PWA: does the operator have a token
   * configured? Returns `true | false` only, never the token itself.
   */
  hasGithubToken: protectedProcedure.query(async ({ ctx }) => {
    return { has: Boolean(ctx.config.githubToken) };
  }),

  /** Whether the Factory GitHub App is configured (gates the issue backend). */
  hasGithubApp: protectedProcedure.query(async ({ ctx }) => {
    return { has: ctx.config.githubApp !== null };
  }),

  /**
   * Flip a project to the GitHub Issues task backend (ADR-007 Phase 2): backfill
   * existing file tasks as issues, archive the local files, record the backend.
   * Refuses when the App is unconfigured, the project has no GitHub remote, or
   * the repo already carries Factory-labeled issues.
   */
  enableGithubIssues: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return enableGithubIssuesBackend({ db: ctx.db, config: ctx.config }, input.id);
    }),

  /**
   * Create a new GitHub repo and push the project's `main` to it. Refuses
   * if the project already has a `githubRemote` (operator must clear via
   * separate path if they want to re-publish). Refuses if no token.
   */
  publishToGithub: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        ownerKind: z.enum(["user", "org"]),
        org: z.string().min(1).max(100).optional(),
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/),
        visibility: z.enum(["public", "private"]),
        description: z.string().max(350).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.config.githubToken) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "no GitHub token configured — set auth.githubToken in ~/.factory/config.yaml",
        });
      }
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.id))
        .get();
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });
      }
      if (project.githubRemote) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `project already published to ${project.githubRemote}`,
        });
      }
      if (input.ownerKind === "org" && !input.org) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "org owner requires `org` field",
        });
      }

      let result: { cloneUrlHttps: string; htmlUrl: string; fullName: string };
      try {
        result = await createRepo({
          token: ctx.config.githubToken,
          owner:
            input.ownerKind === "org"
              ? { kind: "org", org: input.org as string }
              : { kind: "user" },
          name: input.name,
          visibility: input.visibility,
          description: input.description,
        });
      } catch (err) {
        if (err instanceof GithubError) {
          const code =
            err.code === "bad_token"
              ? "UNAUTHORIZED"
              : err.code === "name_conflict"
                ? "CONFLICT"
                : err.code === "rate_limited"
                  ? "TOO_MANY_REQUESTS"
                  : "INTERNAL_SERVER_ERROR";
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }

      try {
        await pushToNewRemote({
          workdirPath: project.workdirPath,
          cloneUrlHttps: result.cloneUrlHttps,
          token: ctx.config.githubToken,
        });
      } catch (err) {
        if (err instanceof GithubError) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `repo created at ${result.htmlUrl} but push failed: ${err.message}`,
          });
        }
        throw err;
      }

      await ctx.db
        .update(schema.projects)
        .set({ githubRemote: result.cloneUrlHttps, lastActivityAt: Date.now() })
        .where(eq(schema.projects.id, input.id));

      return { htmlUrl: result.htmlUrl, fullName: result.fullName };
    }),

  tasks: tasksRouter,
});
