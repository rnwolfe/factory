import { schema, type TaskTemplateDraft } from "@factory/db";
import { TRPCError } from "@trpc/server";
import { desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { loadActiveTemplate } from "../plans/apply-task-template.ts";
import {
  InstantiateTemplateError,
  instantiateTaskTemplate,
} from "../task-templates/instantiate.ts";
import { protectedProcedure, router } from "../trpc.ts";

/**
 * View of a task_templates row served to the PWA. The full draft body
 * comes through as-is — it's already JSON and the PWA needs every field
 * for the form-editor surface.
 */
interface TaskTemplateView {
  id: string;
  slug: string;
  name: string;
  description: string;
  draft: TaskTemplateDraft;
  sourcePlanId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function rowToView(row: typeof schema.taskTemplates.$inferSelect): TaskTemplateView {
  let draft: TaskTemplateDraft;
  try {
    const parsed = JSON.parse(row.draft) as TaskTemplateDraft;
    draft =
      parsed.kind === "task_template" ? parsed : ({ kind: "task_template" } as TaskTemplateDraft);
  } catch {
    draft = {
      kind: "task_template",
      name: row.name,
      description: row.description,
      titlePattern: "",
      labels: [],
      priority: "med",
      estimate: "medium",
      variables: [],
      sections: [],
    };
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    draft,
    sourcePlanId: row.sourcePlanId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const TaskTemplateDraftSchema = z.object({
  kind: z.literal("task_template"),
  name: z.string().min(1).max(120),
  description: z.string().max(400).default(""),
  titlePattern: z.string().min(1).max(200),
  labels: z.array(z.string().max(40)).max(20).default([]),
  priority: z.enum(["low", "med", "high"]).default("med"),
  estimate: z.enum(["small", "medium", "large"]).default("medium"),
  variables: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
        label: z.string().max(80),
        description: z.string().max(200).default(""),
        required: z.boolean().default(true),
        default: z.string().nullable().default(null),
        resolver: z
          .union([
            z.object({ kind: z.literal("operator") }),
            z.object({ kind: z.literal("agent"), prompt: z.string().min(1).max(2000) }),
          ])
          .optional(),
      }),
    )
    .max(20)
    .default([]),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(80),
        kind: z.enum(["static", "agent"]),
        body: z.string().max(8000),
      }),
    )
    .max(20)
    .default([]),
  confirmInInbox: z.boolean().optional(),
});

export const taskTemplatesRouter = router({
  /**
   * List every non-archived template, newest-updated first. Used by the
   * picker on the project page and the list view in settings.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select()
      .from(schema.taskTemplates)
      .where(isNull(schema.taskTemplates.archivedAt))
      .orderBy(desc(schema.taskTemplates.updatedAt))
      .all();
    return rows.map(rowToView);
  }),

  /**
   * Fetch a single template by slug. The form-editor route uses this to
   * hydrate. Returns null for missing/archived templates so the route
   * can render a 404 page instead of throwing.
   */
  bySlug: protectedProcedure.input(z.object({ slug: z.string() })).query(async ({ ctx, input }) => {
    const t = await loadActiveTemplate(ctx.db, input.slug);
    if (!t) return null;
    const row = await ctx.db
      .select()
      .from(schema.taskTemplates)
      .where(eq(schema.taskTemplates.id, t.id))
      .get();
    return row ? rowToView(row) : null;
  }),

  /**
   * Form-editor save. Direct mutation that bypasses the plan-iterate flow
   * for operators who already know what they want. Updates the slug only
   * when the slug field is provided and differs (rare; usually a rename
   * means a new template anyway, but allowed).
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        draft: TaskTemplateDraftSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db
        .select()
        .from(schema.taskTemplates)
        .where(eq(schema.taskTemplates.id, input.id))
        .get();
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "task template not found" });
      }
      const now = Date.now();
      await ctx.db
        .update(schema.taskTemplates)
        .set({
          name: input.draft.name,
          description: input.draft.description,
          draft: JSON.stringify(input.draft),
          updatedAt: now,
        })
        .where(eq(schema.taskTemplates.id, input.id));
      return { ok: true, id: input.id };
    }),

  /**
   * Soft delete — sets `archivedAt`. The row sticks around for audit but
   * disappears from the picker. Re-freezing the same slug from a plan
   * automatically un-archives.
   */
  archive: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.taskTemplates)
        .set({ archivedAt: Date.now(), updatedAt: Date.now() })
        .where(eq(schema.taskTemplates.id, input.id));
      return { ok: true };
    }),

  unarchive: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(schema.taskTemplates)
        .set({ archivedAt: null, updatedAt: Date.now() })
        .where(eq(schema.taskTemplates.id, input.id));
      return { ok: true };
    }),

  /**
   * Apply a template to a target project. Renders any `agent`-kind sections
   * by invoking the model once each (one Claude turn per agent section,
   * scoped to the section's instruction + project context). Returns the
   * new task id so the PWA can navigate straight there.
   */
  instantiate: protectedProcedure
    .input(
      z.object({
        templateSlug: z.string(),
        projectId: z.string(),
        variables: z.record(z.string(), z.string()).default({}),
        renderWithAgent: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await instantiateTaskTemplate({
          db: ctx.db,
          templateSlug: input.templateSlug,
          projectId: input.projectId,
          variables: input.variables,
          renderWithAgent: input.renderWithAgent,
          events: ctx.events,
        });
      } catch (err) {
        if (err instanceof InstantiateTemplateError) {
          const code =
            err.code === "template_not_found" || err.code === "project_not_found"
              ? "NOT_FOUND"
              : "BAD_REQUEST";
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }
    }),
});
