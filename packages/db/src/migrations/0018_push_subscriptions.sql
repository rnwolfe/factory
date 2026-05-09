-- v0.5 — Web Push subscriptions for PWA notifications.
--
-- Each row is one browser/device that opted in. The endpoint is the URL
-- the operating push service (FCM/Mozilla/Apple) gave the browser when it
-- subscribed; the daemon POSTs encrypted payloads there to deliver. We
-- store the ECDH public key (`p256dh`) and the auth secret (`auth`) the
-- subscribe call returned — both are required to encrypt the payload.
--
-- `endpoint` is unique: re-subscribing the same device updates the row
-- rather than duplicating it. `lastSeenAt` tracks the most recent activity
-- for housekeeping (a UI "your devices" list, or pruning idle subs).
-- `ua` is the User-Agent string at subscribe time, purely as a
-- human-readable label for the operator's "your devices" list.

CREATE TABLE `push_subscriptions` (
  `id` text PRIMARY KEY NOT NULL,
  `endpoint` text NOT NULL,
  `p256dh` text NOT NULL,
  `auth` text NOT NULL,
  `ua` text,
  `created_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);
