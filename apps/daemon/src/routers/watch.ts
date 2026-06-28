import { schema } from "@factory/db";
import { count, desc, eq } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc.ts";
import { listHarnessSources } from "../watch/sources/registry.ts";
import { readWatchSynthesisCadence } from "../watch/synthesis-job.ts";

/**
 * Observability for The Watch's synthesis loop (ADR-010). Read-only — surfaces
 * what the loop is doing (cadence, per-source scan cursors, observation funnel,
 * recent output incl. note-only observations that never became inbox cards), so
 * "is The Watch working?" is answerable without grepping logs.
 */
export const watchRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const cadence = readWatchSynthesisCadence(ctx.db);

    const sources = await Promise.all(
      listHarnessSources().map(async (s) => {
        const cursor = ctx.db
          .select({
            position: schema.watchCursors.position,
            updatedAt: schema.watchCursors.updatedAt,
          })
          .from(schema.watchCursors)
          .where(eq(schema.watchCursors.sourceId, s.id))
          .get();
        return {
          id: s.id,
          label: s.label,
          available: await s.isAvailable(),
          /** Opaque scan position (ISO timestamp for the built-in sources). */
          position: cursor?.position ?? null,
          /** When this source was last scanned (cursor advanced). */
          lastScanAt: cursor?.updatedAt ?? null,
        };
      }),
    );

    const byStatus = ctx.db
      .select({ status: schema.watchObservations.status, c: count() })
      .from(schema.watchObservations)
      .groupBy(schema.watchObservations.status)
      .all();
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.c]));

    const recent = ctx.db
      .select({
        id: schema.watchObservations.id,
        kind: schema.watchObservations.kind,
        title: schema.watchObservations.title,
        detail: schema.watchObservations.detail,
        proposal: schema.watchObservations.proposal,
        status: schema.watchObservations.status,
        targetProjectSlug: schema.watchObservations.targetProjectSlug,
        createdAt: schema.watchObservations.createdAt,
      })
      .from(schema.watchObservations)
      .orderBy(desc(schema.watchObservations.createdAt))
      .limit(20)
      .all();

    const lastScanAt = sources.reduce<number | null>(
      (m, s) => (s.lastScanAt && (m === null || s.lastScanAt > m) ? s.lastScanAt : m),
      null,
    );

    return {
      cadence,
      lastScanAt,
      sources,
      observations: {
        total: byStatus.reduce((a, r) => a + r.c, 0),
        pending: counts.pending ?? 0,
        surfaced: counts.surfaced ?? 0,
        adopted: counts.adopted ?? 0,
        dismissed: counts.dismissed ?? 0,
        superseded: counts.superseded ?? 0,
      },
      recent,
    };
  }),
});
