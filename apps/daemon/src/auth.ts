import { TRPCError } from "@trpc/server";
import type { FactoryConfig } from "./config.ts";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * Extract a bearer token from a Fetch `Request`. Looks at:
 *   1. `Authorization: Bearer <token>` header
 *   2. `?token=<token>` query string (used by WebSocket upgrades — browsers
 *      can't send headers on the WS upgrade request).
 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1];
  }
  const url = new URL(req.url);
  const q = url.searchParams.get("token");
  return q && q.length > 0 ? q : null;
}

/**
 * Constant-time token comparison to avoid timing oracles.
 */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function authorizeRequest(req: Request, config: FactoryConfig): boolean {
  const token = extractToken(req);
  if (!token) return false;
  return tokensEqual(token, config.auth.token);
}

export function assertAuthorized(req: Request, config: FactoryConfig): void {
  if (!authorizeRequest(req, config)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Bearer token required" });
  }
}
