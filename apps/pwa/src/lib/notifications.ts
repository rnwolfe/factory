import { trpc } from "./trpc.ts";

const SW_PATH = "/service-worker.js";

/**
 * Lightweight Web Push wrappers for the PWA. Encapsulates the dance of:
 *   1. registering the service worker
 *   2. requesting `Notification.permission`
 *   3. asking the daemon for the VAPID public key
 *   4. calling `pushManager.subscribe(...)` and posting it back
 *
 * Pure side-effecting helpers — no React state. Settings UI invokes these
 * and reads the resulting status via `getStatus()`.
 */

export type PermissionState = "default" | "granted" | "denied" | "unsupported";

export interface NotificationStatus {
  supported: boolean;
  /** secure-context check — push needs https or localhost. */
  secure: boolean;
  permission: PermissionState;
  subscribed: boolean;
}

function isSecureContext(): boolean {
  if (typeof window === "undefined") return false;
  // localhost/127.0.0.1 count as secure for service-worker registration.
  if (window.isSecureContext) return true;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getStatus(): Promise<NotificationStatus> {
  if (!isSupported()) {
    return {
      supported: false,
      secure: isSecureContext(),
      permission: "unsupported",
      subscribed: false,
    };
  }
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return {
    supported: true,
    secure: isSecureContext(),
    permission: Notification.permission as PermissionState,
    subscribed: Boolean(sub),
  };
}

/**
 * Idempotently register the SW. Safe to call from `main.tsx` on every
 * launch — `register` resolves the existing registration if present.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  if (!isSecureContext()) return null;
  try {
    const reg = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
    return reg;
  } catch (err) {
    console.warn("[notifications] service worker registration failed", err);
    return null;
  }
}

function urlBase64ToBuffer(base64: string): ArrayBuffer {
  // VAPID public keys arrive as URL-safe base64 with no padding. The
  // browser's `applicationServerKey` expects a BufferSource — using a fresh
  // ArrayBuffer (not Uint8Array over a possibly-shared backing store)
  // sidesteps a TS narrowing where Uint8Array's buffer is `ArrayBufferLike`.
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  // Standard base64, then make URL-safe (the daemon's `web-push` expects
  // either form, but URL-safe matches the on-disk convention).
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Walk the full enable flow. Throws on any step the operator should know
 * about (denied permission, missing VAPID key, subscribe failure). Returns
 * the resulting subscription on success.
 */
export async function enable(): Promise<NotificationStatus> {
  if (!isSupported()) throw new Error("push notifications are not supported in this browser");
  if (!isSecureContext()) {
    throw new Error(
      "push needs https or localhost. open the PWA over https or via http://localhost.",
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notification permission was not granted");

  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  if (!reg) throw new Error("service worker failed to register");

  const { publicKey } = await trpc.notifications.getPublicKey.query();
  if (!publicKey) {
    throw new Error("the daemon hasn't generated a VAPID keypair yet — restart the daemon");
  }

  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(publicKey),
    }));

  const json = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  const endpoint = json.endpoint ?? sub.endpoint;
  const p256dh = json.keys?.p256dh ?? arrayBufferToBase64Url(sub.getKey("p256dh"));
  const auth = json.keys?.auth ?? arrayBufferToBase64Url(sub.getKey("auth"));
  if (!endpoint || !p256dh || !auth) {
    throw new Error("subscription is missing endpoint or keys");
  }

  await trpc.notifications.subscribe.mutate({
    endpoint,
    p256dh,
    auth,
    ua: navigator.userAgent,
  });

  return getStatus();
}

export async function disable(): Promise<NotificationStatus> {
  if (!isSupported()) return getStatus();
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const endpoint = sub.endpoint;
    try {
      await sub.unsubscribe();
    } catch (err) {
      console.warn("[notifications] browser unsubscribe failed", err);
    }
    try {
      await trpc.notifications.unsubscribe.mutate({ endpoint });
    } catch (err) {
      console.warn("[notifications] server unsubscribe failed", err);
    }
  }
  return getStatus();
}

export async function sendTest(): Promise<{ sent: number; failed: number }> {
  const res = await trpc.notifications.test.mutate();
  return { sent: res.sent, failed: res.failed };
}
