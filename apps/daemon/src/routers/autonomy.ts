import { schema } from "@factory/db";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  AUTONOMY_PRESETS,
  type AutonomyOverride,
  BUILTIN_AUTONOMY,
  resolveAutonomyConfig,
} from "../autonomy/config.ts";
import { readAllSettings, setSetting } from "../settings/store.ts";
import { protectedProcedure, router } from "../trpc.ts";

const levelEnum = z.enum(["none", "low", "medium", "high"]);
const blastEnum = z.enum(["contained", "broad"]);
const cadenceEnum = z.enum(["off", "hourly", "daily", "weekly"]);
const alertEnum = z.enum(["off", "push", "digest"]);
const presetEnum = z.enum(["conservative", "balanced", "hands-off"]);

/** A partial autonomy override — every field optional, validated per knob. */
const overrideSchema = z
  .object({
    trust: z
      .object({
        autoPromote: z.boolean(),
        promoteStreak: z.number().int().min(1).max(50),
        autoContract: z.boolean(),
      })
      .partial(),
    gate: z
      .object({ minLevel: levelEnum, maxBlastRadius: blastEnum, crossModel: z.boolean() })
      .partial(),
    watch: z
      .object({
        synthesisCadence: cadenceEnum,
        generatorEnabled: z.boolean(),
        inbandGroom: z.boolean(),
      })
      .partial(),
    autorun: z
      .object({
        enabled: z.boolean(),
        maxBlastRadius: blastEnum,
        classes: z.array(z.string()),
        maxPerTick: z.number().int().min(1).max(20),
        requireQualityGate: z.boolean(),
        emergencyStop: z.boolean(),
      })
      .partial(),
    retry: z
      .object({
        transientBudget: z.number().int().min(0).max(10),
        verifierBudget: z.number().int().min(0).max(10),
      })
      .partial(),
    alerts: z.record(z.string(), alertEnum),
  })
  .partial();

function parseOverride(raw: string | null | undefined): AutonomyOverride | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AutonomyOverride;
  } catch {
    return null;
  }
}

export const autonomyRouter = router({
  /**
   * The effective policy for a scope + the raw system/project overrides, so the
   * UI can render each knob as inherited vs overridden, and the presets.
   */
  config: protectedProcedure
    .input(z.object({ projectId: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      const projectId = input?.projectId ?? null;
      const systemOverride = parseOverride(readAllSettings(ctx.db).get("autonomy-config"));
      const projectOverride = projectId
        ? parseOverride(
            ctx.db
              .select({ ac: schema.projects.autonomyConfig })
              .from(schema.projects)
              .where(eq(schema.projects.id, projectId))
              .get()?.ac,
          )
        : null;
      return {
        resolved: resolveAutonomyConfig(ctx.db, projectId),
        builtin: BUILTIN_AUTONOMY,
        systemOverride,
        projectOverride,
        presets: AUTONOMY_PRESETS,
      };
    }),

  /** Replace the system-level override blob (deep-merged over built-in defaults). */
  setSystem: protectedProcedure
    .input(z.object({ override: overrideSchema }))
    .mutation(({ ctx, input }) => {
      setSetting(ctx.db, ctx.config, "autonomy-config", JSON.stringify(input.override));
      return resolveAutonomyConfig(ctx.db);
    }),

  /** Replace (or clear) a project's override blob. */
  setProject: protectedProcedure
    .input(z.object({ projectId: z.string(), override: overrideSchema.nullable() }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(schema.projects)
        .set({ autonomyConfig: input.override ? JSON.stringify(input.override) : null })
        .where(eq(schema.projects.id, input.projectId))
        .run();
      return resolveAutonomyConfig(ctx.db, input.projectId);
    }),

  /** Apply a preset's bundle at the chosen scope (overwrites that scope's blob). */
  applyPreset: protectedProcedure
    .input(
      z.object({
        scope: z.enum(["system", "project"]),
        projectId: z.string().optional(),
        preset: presetEnum,
      }),
    )
    .mutation(({ ctx, input }) => {
      const blob = JSON.stringify(AUTONOMY_PRESETS[input.preset]);
      if (input.scope === "system") {
        setSetting(ctx.db, ctx.config, "autonomy-config", blob);
        return resolveAutonomyConfig(ctx.db);
      }
      if (!input.projectId) throw new Error("projectId required for project scope");
      ctx.db
        .update(schema.projects)
        .set({ autonomyConfig: blob })
        .where(eq(schema.projects.id, input.projectId))
        .run();
      return resolveAutonomyConfig(ctx.db, input.projectId);
    }),

  /** The autonomy event log — what the system did unattended (ADR-016 /ops history). */
  history: protectedProcedure
    .input(
      z.object({
        projectId: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(({ ctx, input }) => {
      const cond = input.projectId
        ? eq(schema.autonomyEvents.projectId, input.projectId)
        : undefined;
      return ctx.db
        .select()
        .from(schema.autonomyEvents)
        .where(cond)
        .orderBy(desc(schema.autonomyEvents.createdAt))
        .limit(input.limit)
        .all();
    }),
});
