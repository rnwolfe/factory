import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { appendOperatorComment, listAuditComments, runAgentReply } from "../audits/comments.ts";
import { runExecAudit } from "../audits/exec-iterate.ts";
import { readFindings, writeFindings } from "../audits/findings.ts";
import { runAuditIteration } from "../audits/iterate.ts";
import { bridgePromoteFindings } from "../audits/promote.ts";
import { computeSkillVersion } from "../audits/prompts.ts";
import { commitApprovedAuditReport } from "../audits/report-commit.ts";
import { installAuditTemplate, listAuditTemplates } from "../audits/templates.ts";
import { seedTaskPlanDraft } from "../plans/iterate.ts";
import { listAuditSkills, readAuditSkill } from "../projects/audit-skills.ts";
import { createTask } from "../projects/tasks.ts";
import { protectedProcedure, router } from "../trpc.ts";

const AuditStatusEnum = z.enum([
  "running",
  "completed",
  "reviewed",
  "approved",
  "rejected",
  "failed",
]);

export const auditsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.array(AuditStatusEnum).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where = input.status?.length
        ? and(
            eq(schema.audits.projectId, input.projectId),
            inArray(schema.audits.status, input.status),
          )
        : eq(schema.audits.projectId, input.projectId);
      return ctx.db
        .select()
        .from(schema.audits)
        .where(where)
        .orderBy(desc(schema.audits.startedAt))
        .all();
    }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return (
      (await ctx.db.select().from(schema.audits).where(eq(schema.audits.id, input.id)).get()) ??
      null
    );
  }),

  /**
   * Completed (and not yet reviewed) audits across all projects, ordered by
   * completedAt desc. Surfaced in the inbox alongside drafting plans + pending
   * decisions.
   */
  inbox: protectedProcedure.query(async ({ ctx }) => {
    const now = Date.now();
    return ctx.db
      .select()
      .from(schema.audits)
      .where(
        and(
          eq(schema.audits.status, "completed"),
          or(isNull(schema.audits.snoozedUntil), lte(schema.audits.snoozedUntil, now)),
        ),
      )
      .orderBy(desc(schema.audits.startedAt))
      .all();
  }),

  listSkills: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) return [];
      return listAuditSkills(project.workdirPath);
    }),

  /**
   * List audit skill templates shipped under `docs/audit-skill-templates/`.
   * Used by the audits section to render install buttons. Returns name +
   * frontmatter so the UI can render the same chips as installed skills.
   */
  listTemplates: protectedProcedure.query(async () => {
    return listAuditTemplates();
  }),

  /**
   * Copy a shipped template into a project's `.factory/audits/<name>/SKILL.md`
   * and commit it on the project's main branch. Idempotent: re-installing a
   * template that's already present is a no-op (we don't clobber operator
   * customizations).
   */
  installTemplate: protectedProcedure
    .input(z.object({ projectId: z.string(), templateName: z.string().min(1).max(60) }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });
      try {
        const result = await installAuditTemplate({
          config: ctx.config,
          workdirPath: project.workdirPath,
          templateName: input.templateName,
        });
        await ctx.db
          .update(schema.projects)
          .set({ lastActivityAt: Date.now() })
          .where(eq(schema.projects.id, project.id));
        return {
          name: result.frontmatter.name,
          kind: result.frontmatter.kind,
          alreadyInstalled: result.alreadyInstalled,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }
    }),

  submit: protectedProcedure
    .input(z.object({ projectId: z.string(), skillName: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .get();
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });

      const skill = await readAuditSkill(project.workdirPath, input.skillName);
      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `skill ${input.skillName} not installed in this project`,
        });
      }

      const auditId = createId();
      const now = Date.now();
      const skillVersion = await computeSkillVersion(project.workdirPath, input.skillName);
      await ctx.db.insert(schema.audits).values({
        id: auditId,
        projectId: project.id,
        skillName: input.skillName,
        skillVersion,
        status: "running",
        startedAt: now,
      });
      ctx.events.publish({
        channel: "inbox",
        kind: "audit_started",
        auditId,
        projectId: project.id,
        skillName: input.skillName,
      });

      // Read-only and exec audits both fan out into the background. Read-only
      // uses `claude --print`, no worktree; exec creates a per-audit worktree
      // and spawns claude with cwd set so its shell tools see project state.
      const isExec = skill.frontmatter.kind === "exec";

      void (async () => {
        try {
          if (isExec) {
            await runExecAudit(ctx.config, ctx.db, auditId);
          } else {
            await runAuditIteration(ctx.db, auditId);
          }
          ctx.events.publish({
            channel: "inbox",
            kind: "audit_completed",
            auditId,
            projectId: project.id,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[audit-iterate] ${auditId}: ${message}`);
          await ctx.db
            .update(schema.audits)
            .set({
              status: "failed",
              completedAt: Date.now(),
              reportMarkdown: `# ${input.skillName} — failed\n\n${message.slice(0, 500)}\n`,
            })
            .where(eq(schema.audits.id, auditId));
          ctx.events.publish({
            channel: "inbox",
            kind: "audit_completed",
            auditId,
            projectId: project.id,
          });
        }
      })();

      return { auditId };
    }),

  markReviewed: protectedProcedure
    .input(z.object({ auditId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const audit = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, input.auditId))
        .get();
      if (!audit) throw new TRPCError({ code: "NOT_FOUND", message: "audit not found" });
      if (audit.reviewedAt) return { audit }; // idempotent
      if (audit.status !== "completed" && audit.status !== "reviewed") {
        // Only mark reviewed if we're at least past completed. Idempotent for
        // already-reviewed.
        return { audit };
      }
      const now = Date.now();
      await ctx.db
        .update(schema.audits)
        .set({ status: "reviewed", reviewedAt: now })
        .where(eq(schema.audits.id, input.auditId));
      const refreshed = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, input.auditId))
        .get();
      ctx.events.publish({ channel: "inbox", kind: "audit_updated", auditId: input.auditId });
      return { audit: refreshed };
    }),

  approve: protectedProcedure
    .input(z.object({ auditId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const audit = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, input.auditId))
        .get();
      if (!audit) throw new TRPCError({ code: "NOT_FOUND", message: "audit not found" });
      if (audit.status === "approved") {
        return { audit, reportPath: audit.approvedReportPath ?? "" };
      }
      if (audit.status !== "completed" && audit.status !== "reviewed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `audit ${audit.status} — only completed/reviewed can be approved`,
        });
      }
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, audit.projectId))
        .get();
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });

      const { reportPath } = await commitApprovedAuditReport({
        config: ctx.config,
        workdirPath: project.workdirPath,
        audit,
      });
      const now = Date.now();
      await ctx.db
        .update(schema.audits)
        .set({ status: "approved", approvedAt: now, approvedReportPath: reportPath })
        .where(eq(schema.audits.id, audit.id));
      const refreshed = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, audit.id))
        .get();
      ctx.events.publish({
        channel: "inbox",
        kind: "audit_approved",
        auditId: audit.id,
        projectId: project.id,
        reportPath,
      });
      return { audit: refreshed, reportPath };
    }),

  reject: protectedProcedure
    .input(z.object({ auditId: z.string(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const audit = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, input.auditId))
        .get();
      if (!audit) throw new TRPCError({ code: "NOT_FOUND", message: "audit not found" });
      if (audit.status === "rejected") return { audit };
      if (audit.status !== "completed" && audit.status !== "reviewed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `audit ${audit.status} — only completed/reviewed can be rejected`,
        });
      }
      const now = Date.now();
      await ctx.db
        .update(schema.audits)
        .set({ status: "rejected", rejectedAt: now })
        .where(eq(schema.audits.id, audit.id));
      const refreshed = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, audit.id))
        .get();
      ctx.events.publish({
        channel: "inbox",
        kind: "audit_rejected",
        auditId: audit.id,
        projectId: audit.projectId,
      });
      return { audit: refreshed };
    }),

  promoteFindings: protectedProcedure
    .input(
      z.object({
        auditId: z.string(),
        findingIds: z.array(z.string()).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const audit = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, input.auditId))
        .get();
      if (!audit) throw new TRPCError({ code: "NOT_FOUND", message: "audit not found" });
      const project = await ctx.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, audit.projectId))
        .get();
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });

      const allFindings = readFindings(audit.findings);
      const selected = allFindings.filter((f) => input.findingIds.includes(f.id));
      if (selected.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "no findings matched the provided ids",
        });
      }

      const recommendation = await bridgePromoteFindings({
        db: ctx.db,
        project,
        audit,
        findings: selected,
      });

      const now = Date.now();
      let promotedTo: { kind: "plan" | "task"; id: string };
      let planId: string | undefined;
      let taskId: string | undefined;

      if (recommendation.recommendation === "plan") {
        // Create a drafting plan seeded with the bridge's drafted goal as the
        // operator's first comment. The agent will iterate from there.
        const newPlanId = createId();
        const seed =
          recommendation.planKind === "task_plan"
            ? seedTaskPlanDraft()
            : {
                kind: "feature_plan" as const,
                goal: recommendation.goal,
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
        await ctx.db.insert(schema.plans).values({
          id: newPlanId,
          kind: recommendation.planKind,
          status: "drafting",
          projectId: project.id,
          goal: recommendation.goal,
          draft: JSON.stringify(seed),
          ceremony: project.ceremony ?? null,
          createdAt: now,
          updatedAt: now,
        });
        // Auto-comment with the bridge's reasoning + selected findings as
        // context — gives the agent something to iterate against.
        const findingsBlob = selected.map((f) => `- (${f.severity}) ${f.title}`).join("\n");
        await ctx.db.insert(schema.planComments).values({
          id: createId(),
          planId: newPlanId,
          role: "operator",
          body: `Promoted from audit ${audit.skillName}.\n\n${recommendation.reasoning}\n\nFindings:\n${findingsBlob}`,
          createdAt: now,
        });
        planId = newPlanId;
        promotedTo = { kind: "plan", id: newPlanId };
        ctx.events.publish({
          channel: "inbox",
          kind: "plan_created",
          planId: newPlanId,
          planKind: recommendation.planKind,
          projectId: project.id,
        });
      } else {
        const findingsContext = selected
          .map((f) => {
            const ref = f.filePath
              ? ` (\`${f.filePath}${f.line !== null ? `:${f.line}` : ""}\`)`
              : "";
            return `- (${f.severity}) ${f.title}${ref}`;
          })
          .join("\n");
        const body = `## Notes\n\nCaptured from audit \`${audit.skillName}\`.\n\n${recommendation.taskBody}\n\n## Source findings\n\n${findingsContext}\n`;
        const created = await createTask(project, {
          title: recommendation.taskTitle,
          body,
          labels: ["bug", "needs-refinement"],
          priority: "med",
        });
        taskId = created.id;
        promotedTo = { kind: "task", id: created.id };
      }

      // Update the findings JSON to mark each promoted finding's pointer.
      const updatedFindings = allFindings.map((f) => {
        if (input.findingIds.includes(f.id)) return { ...f, promotedTo };
        return f;
      });
      await ctx.db
        .update(schema.audits)
        .set({ findings: writeFindings(updatedFindings) })
        .where(eq(schema.audits.id, audit.id));

      for (const f of selected) {
        ctx.events.publish({
          channel: "inbox",
          kind: "finding_promoted",
          auditId: audit.id,
          findingId: f.id,
          promotedTo,
        });
      }

      return {
        recommendation: recommendation.recommendation,
        reasoning: recommendation.reasoning,
        planId,
        taskId,
      };
    }),

  /**
   * Thread of operator and agent comments on a completed audit. v0.4 cut 5
   * replaces the v0.3 "append a Discussion section to reportMarkdown"
   * approach with a proper table — same shape as plan/decision threads.
   * Pre-existing inline `## Discussion` sections in older `reportMarkdown`
   * are left in place; this list is the authoritative thread going forward.
   */
  comments: protectedProcedure
    .input(z.object({ auditId: z.string() }))
    .query(async ({ ctx, input }) => {
      return listAuditComments(ctx.db, input.auditId);
    }),

  /**
   * Operator follow-up on a completed audit. Persists the operator row,
   * fires the agent reply in the background (best-effort, resumed session),
   * and broadcasts `audit_updated` so the open pane refetches.
   */
  comment: protectedProcedure
    .input(z.object({ auditId: z.string(), body: z.string().trim().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const audit = await ctx.db
        .select()
        .from(schema.audits)
        .where(eq(schema.audits.id, input.auditId))
        .get();
      if (!audit) throw new TRPCError({ code: "NOT_FOUND", message: "audit not found" });
      if (audit.status === "running" || audit.status === "failed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `audit ${audit.status} — comment only on completed reports`,
        });
      }

      const opComment = await appendOperatorComment(ctx.db, audit.id, input.body.trim());
      ctx.events.publish({
        channel: "inbox",
        kind: "audit_updated",
        auditId: audit.id,
        projectId: audit.projectId,
      });

      // Background agent reply — same fire-and-forget shape as plan/decision
      // threads. Errors land as agent-role rows so the operator isn't left
      // staring at a stalled thinking spinner.
      void (async () => {
        await runAgentReply(ctx.db, audit.id, opComment.body);
        ctx.events.publish({
          channel: "inbox",
          kind: "audit_updated",
          auditId: audit.id,
          projectId: audit.projectId,
        });
      })();

      return { commentId: opComment.id };
    }),
});
