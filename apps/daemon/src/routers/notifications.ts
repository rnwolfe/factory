import { schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.ts";

/**
 * PWA-facing endpoints for the Web Push lifecycle:
 *   - `getPublicKey` — read the daemon's VAPID public key so the PWA can
 *     hand it to `pushManager.subscribe({ applicationServerKey })`.
 *   - `subscribe` — persist the browser-issued subscription (endpoint +
 *     keys) so the dispatcher can target it. Idempotent on `endpoint`.
 *   - `unsubscribe` — remove a subscription by endpoint.
 *   - `listDevices` — settings UI lists each enrolled browser/device.
 *   - `removeDevice` — settings UI removes one by id.
 *   - `test` — fire a synthetic push to all enrolled devices so the
 *     operator can verify their setup end-to-end without waiting for real
 *     events.
 */
export const notificationsRouter = router({
  getPublicKey: protectedProcedure.query(({ ctx }) => {
    const key = ctx.config.vapid.publicKey;
    return { publicKey: key && key.length > 0 ? key : null };
  }),

  subscribe: protectedProcedure
    .input(
      z.object({
        endpoint: z.string().url(),
        p256dh: z.string().min(1),
        auth: z.string().min(1),
        ua: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = Date.now();
      const existing = await ctx.db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpoint, input.endpoint))
        .get();
      if (existing) {
        // Refresh keys + ua + lastSeenAt; the browser may have rotated.
        await ctx.db
          .update(schema.pushSubscriptions)
          .set({
            p256dh: input.p256dh,
            auth: input.auth,
            ua: input.ua ?? existing.ua,
            lastSeenAt: now,
          })
          .where(eq(schema.pushSubscriptions.id, existing.id));
        return { id: existing.id, created: false };
      }
      const id = createId();
      await ctx.db.insert(schema.pushSubscriptions).values({
        id,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        ua: input.ua ?? null,
        createdAt: now,
        lastSeenAt: now,
      });
      return { id, created: true };
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpoint, input.endpoint));
      return { ok: true };
    }),

  listDevices: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: schema.pushSubscriptions.id,
        ua: schema.pushSubscriptions.ua,
        createdAt: schema.pushSubscriptions.createdAt,
        lastSeenAt: schema.pushSubscriptions.lastSeenAt,
      })
      .from(schema.pushSubscriptions)
      .all();
    return rows;
  }),

  removeDevice: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.id, input.id));
      return { ok: true };
    }),

  test: protectedProcedure.mutation(async ({ ctx }) => {
    const subs = await ctx.db.select().from(schema.pushSubscriptions).all();
    if (subs.length === 0) return { sent: 0, failed: 0 };
    if (!ctx.config.vapid.publicKey || !ctx.config.vapid.privateKey) {
      return { sent: 0, failed: 0, reason: "no vapid keypair" as const };
    }
    const { default: webpush } = await import("web-push");
    webpush.setVapidDetails(
      ctx.config.vapid.subject,
      ctx.config.vapid.publicKey,
      ctx.config.vapid.privateKey,
    );
    const body = JSON.stringify({
      title: "factory test",
      body: "if you see this, push notifications are working.",
      url: "/settings",
      tag: "test",
    });
    let sent = 0;
    let failed = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 60 * 5 },
          );
          sent += 1;
        } catch (err) {
          failed += 1;
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            await ctx.db
              .delete(schema.pushSubscriptions)
              .where(eq(schema.pushSubscriptions.id, sub.id));
          }
        }
      }),
    );
    return { sent, failed };
  }),
});
