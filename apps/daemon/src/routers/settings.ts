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
      githubToken: { has: snap.githubToken !== null && snap.githubToken.length > 0 },
      factoryProjectId: snap.factoryProjectId,
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
        if (!Number.isFinite(n) || n < 60 || n > 24 * 3600) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "default-run-budget-seconds: 60..86400",
          });
        }
      }
      if (input.key === "git-author-email" && input.value && !/.+@.+/.test(input.value)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "git-author-email looks malformed" });
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
