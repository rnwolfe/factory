import { gt, isNull, lte, or, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

/**
 * Inbox snooze views shared across the decision / plan / audit / feedback
 * inboxes. "active" is the default operator view (snooze hides the row);
 * "snoozed" surfaces the currently-snoozed backlog so nothing is lost.
 */
export type InboxView = "active" | "snoozed";

/**
 * tRPC input shape for inbox queries. `.default({})` keeps the no-arg call
 * site (`trpc.x.inbox.query()`) valid while still defaulting the view.
 */
export const inboxViewInput = z
  .object({ view: z.enum(["active", "snoozed"]).default("active") })
  .default({ view: "active" });

/**
 * Snooze predicate for an inbox query, parameterized by the row's
 * `snoozedUntil` column.
 * - "active": never snoozed, or the snooze has already expired (`<= now`).
 * - "snoozed": still snoozed — resurfaces at some point in the future.
 *
 * `gt(col, now)` is null-safe in SQLite: rows with a null `snoozedUntil`
 * fail the comparison, so they correctly never appear in the snoozed view.
 */
export function snoozeWhere(col: AnySQLiteColumn, view: InboxView, now: number): SQL | undefined {
  return view === "snoozed" ? gt(col, now) : or(isNull(col), lte(col, now));
}
