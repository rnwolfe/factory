import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  clearSetting,
  isSettingKey,
  SETTING_KEYS,
  setSetting,
  snapshotSettings,
} from "../settings/store.ts";
import { protectedProcedure, router } from "../trpc.ts";

const KeyEnum = z.enum(SETTING_KEYS as unknown as [string, ...string[]]);

export const settingsRouter = router({
  /**
   * Snapshot of every operator-tunable setting plus an `overridden` map
   * showing which keys have a DB override vs. yaml/env defaults. The token
   * is redacted to a presence-only `{ has: boolean }` field — the operator
   * can see whether one is configured but not its value.
   */
  get: protectedProcedure.query(({ ctx }) => {
    const snap = snapshotSettings(ctx.db, ctx.config);
    return {
      gitAuthor: snap.gitAuthor,
      maxConcurrentRuns: snap.maxConcurrentRuns,
      defaultRunBudgetSeconds: snap.defaultRunBudgetSeconds,
      agentBudgetSeconds: snap.agentBudgetSeconds,
      githubToken: { has: snap.githubToken !== null && snap.githubToken.length > 0 },
      factoryProjectId: snap.factoryProjectId,
      notifyOnRunComplete: snap.notifyOnRunComplete,
      ops: {
        landingRoute: snap.ops.landingRoute,
        defaultModel: snap.ops.defaultModel,
        defaultAgent: snap.ops.defaultAgent,
        experimentalFable5: snap.ops.experimentalFable5,
      },
      overridden: snap.overridden,
    };
  }),

  /**
   * Set one setting. Empty string on `github-token` or `factory-project-id`
   * clears the DB override and lets the yaml default win again.
   */
  set: protectedProcedure
    .input(z.object({ key: KeyEnum, value: z.string() }))
    .mutation(({ ctx, input }) => {
      if (!isSettingKey(input.key)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "unknown setting key" });
      }
      // Validate per-key.
      if (input.key === "max-concurrent-runs") {
        const n = Number.parseInt(input.value, 10);
        if (!Number.isFinite(n) || n < 1 || n > 32) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "max-concurrent-runs: 1..32" });
        }
      }
      if (input.key === "default-run-budget-seconds") {
        const n = Number.parseInt(input.value, 10);
        // 0 = infinite (matches running `claude` by hand). Otherwise 60..86400.
        if (!Number.isFinite(n) || (n !== 0 && (n < 60 || n > 24 * 3600))) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "default-run-budget-seconds: 0 (infinite) or 60..86400",
          });
        }
      }
      if (input.key === "agent-budget-seconds") {
        const n = Number.parseInt(input.value, 10);
        // 0 = unlimited (default). Otherwise 30..86400 — short-iteration calls
        // (triage, plan, audit, feedback) should never need more than a day.
        if (!Number.isFinite(n) || (n !== 0 && (n < 30 || n > 24 * 3600))) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "agent-budget-seconds: 0 (unlimited) or 30..86400",
          });
        }
      }
      if (input.key === "git-author-email" && input.value && !/.+@.+/.test(input.value)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "git-author-email looks malformed" });
      }
      if (
        input.key === "notify-on-run-complete" &&
        input.value !== "true" &&
        input.value !== "false"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "notify-on-run-complete: 'true' or 'false'",
        });
      }
      if (
        input.key === "experimental-fable-5" &&
        input.value !== "true" &&
        input.value !== "false"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "experimental-fable-5: 'true' or 'false'",
        });
      }
      if (input.key === "landing-route" && input.value !== "inbox" && input.value !== "ops") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "landing-route: 'inbox' or 'ops'",
        });
      }
      // default-model is opaque (CLI accepts any model id); just trim
      // accidental whitespace and let an empty string clear the override.
      if (input.key === "default-model") {
        input.value = input.value.trim();
      }
      setSetting(ctx.db, ctx.config, input.key, input.value);
      return { ok: true };
    }),

  /** Drop a setting back to its yaml/env default. */
  clear: protectedProcedure.input(z.object({ key: KeyEnum })).mutation(({ ctx, input }) => {
    if (!isSettingKey(input.key)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "unknown setting key" });
    }
    clearSetting(ctx.db, ctx.config, input.key);
    return { ok: true };
  }),
});
