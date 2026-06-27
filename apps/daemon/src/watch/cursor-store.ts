import { type Db, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { WatchCursor } from "./sources/types.ts";

/**
 * Durable per-source scan positions (ADR-010 §3). Replaces slice-2's in-memory
 * map so a daemon restart resumes where the last scan left off instead of
 * re-reading the whole lookback window. Synchronous (bun-sqlite) — safe to call
 * from the async job.
 */
export interface CursorStore {
  get(sourceId: string): WatchCursor | null;
  set(cursor: WatchCursor): void;
}

export function createDbCursorStore(db: Db): CursorStore {
  return {
    get(sourceId) {
      const row = db
        .select()
        .from(schema.watchCursors)
        .where(eq(schema.watchCursors.sourceId, sourceId))
        .get();
      return row ? { sourceId: row.sourceId, position: row.position } : null;
    },
    set(cursor) {
      const now = Date.now();
      db.insert(schema.watchCursors)
        .values({ sourceId: cursor.sourceId, position: cursor.position, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.watchCursors.sourceId,
          set: { position: cursor.position, updatedAt: now },
        })
        .run();
    },
  };
}

/** Non-durable store for tests / the default when no DB store is supplied. */
export function createMemoryCursorStore(): CursorStore {
  const m = new Map<string, WatchCursor>();
  return {
    get: (sourceId) => m.get(sourceId) ?? null,
    set: (cursor) => void m.set(cursor.sourceId, cursor),
  };
}
