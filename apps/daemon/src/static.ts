import { existsSync } from "node:fs";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font-data/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve a Vite-built single-page app from `distRoot`. Returns null if the
 * request doesn't correspond to a file the daemon should answer for (so the
 * router can fall through to 404).
 *
 * Notes:
 *   - SPA fallback: anything that isn't an asset (no file extension match)
 *     resolves to /index.html so React Router can take over.
 *   - Static assets get a long max-age; index.html gets no-cache.
 */
export function makeStaticHandler(distRoot: string): (req: Request) => Response | null {
  if (!existsSync(distRoot)) {
    return () => null;
  }

  return (req: Request): Response | null => {
    const url = new URL(req.url);
    if (
      url.pathname.startsWith("/trpc") ||
      url.pathname.startsWith("/ws/") ||
      url.pathname === "/health"
    ) {
      return null;
    }
    if (url.pathname.includes("..")) {
      return new Response("Forbidden", { status: 403 });
    }

    // Browsers ask for /favicon.ico unconditionally regardless of the SVG link
    // tag in index.html. Reply with a 204 instead of letting it 404 and bloat
    // the daemon log.
    if (url.pathname === "/favicon.ico") {
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "public, max-age=86400" },
      });
    }

    const candidate = path.join(distRoot, decodeURIComponent(url.pathname));
    const safeRoot = path.resolve(distRoot);
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(safeRoot)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const isAsset = ext.length > 0 && TYPES[ext] !== undefined;

    if (isAsset) {
      const headers: Record<string, string> = {
        "content-type": TYPES[ext] ?? "application/octet-stream",
      };
      // /assets/* paths are content-hashed by Vite — cache aggressively.
      if (url.pathname.startsWith("/assets/")) {
        headers["cache-control"] = "public, max-age=31536000, immutable";
      } else {
        headers["cache-control"] = "no-cache";
      }
      return new Response(file, { headers });
    }

    // SPA fallback.
    const index = Bun.file(path.join(distRoot, "index.html"));
    return new Response(index, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  };
}
