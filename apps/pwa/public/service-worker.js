/* eslint-disable */
// Factory PWA service worker. Two responsibilities:
//   1. push: receive encrypted payloads from the daemon and show a
//      notification using `self.registration.showNotification`.
//   2. notificationclick: focus an existing PWA tab if one's open;
//      otherwise open a new one at the deep-link URL the payload carries.
//
// Plain JS on purpose — keeps the build simple (one file, no Vite plugin)
// and avoids any framework code path running at SW lifecycle.

self.addEventListener("install", (event) => {
  // Activate immediately on install so a newly registered SW starts
  // handling pushes without waiting for all clients to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Take over open clients (existing PWA tabs) so they can receive
  // messages from this SW without a refresh.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_err) {
      data = { title: "factory", body: event.data.text() };
    }
  }
  const title = data.title || "factory";
  const body = data.body || "";
  const url = data.url || "/";
  const tag = data.tag || undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // Coalesce repeated pushes for the same target (decision_updated etc.)
      // by reusing tag — newer push replaces older same-tag notification.
      renotify: Boolean(tag),
      data: { url },
      // Light vibration on phone when the screen is off. Desktop ignores.
      vibrate: [40, 20, 40],
      // Use the favicon as the small icon so the notification is
      // recognizably ours. Path is a stable static asset.
      badge: "/favicon.ico",
      icon: "/favicon.ico",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Prefer focusing an already-open PWA tab and navigating it. Avoids
      // stacking duplicate windows when the operator taps repeatedly.
      for (const client of all) {
        try {
          const u = new URL(client.url);
          if (u.origin === self.location.origin) {
            await client.focus();
            if ("navigate" in client && typeof client.navigate === "function") {
              try {
                await client.navigate(target);
              } catch (_err) {
                // Some browsers reject cross-origin navigates; fallthrough
                // to postMessage so the SPA's router can do the work.
              }
            }
            client.postMessage({ type: "factory-notification-click", url: target });
            return;
          }
        } catch (_err) {
          // ignore malformed client urls
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// `pushsubscriptionchange` fires when the browser rotates the subscription
// (rare; happens after long idle or push-service config changes). We can't
// re-subscribe here without the application server key, so we just clear
// the local mark — the PWA will re-subscribe on next visit.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      // No-op for now. The app's notifications.ts checks subscription
      // freshness on each launch and re-subscribes if needed.
    })(),
  );
});
