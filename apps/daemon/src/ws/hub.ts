import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import { authorizeRequest } from "../auth.ts";
import type { DaemonContext } from "../context.ts";
import type { DaemonEvent } from "../events.ts";

export type WsChannel = "events" | "pane" | "inbox" | "script";

/**
 * Scope filter parsed off `?scope=<kind>:<id>` on the events channel.
 * - `run`/`pane`: bound to a specific run.
 * - `project`: fan-out for the project-detail page; matches events by
 *   projectId, or by auditId/planId/runId resolved against the DB.
 * - `audit`/`plan`/`decision`: fan-out for the corresponding detail pages.
 *
 * The legacy `?runId=X` form is interpreted as `scope=run:X` so the live-pane
 * route keeps working without changes.
 */
export type EventsScope =
  | { kind: "run"; id: string }
  | { kind: "project"; id: string }
  | { kind: "audit"; id: string }
  | { kind: "plan"; id: string }
  | { kind: "decision"; id: string }
  | { kind: "feedback"; id: string };

export interface WsClientData {
  channel: WsChannel;
  /** Set on `pane` channel; legacy carrier on `events` (== scope.kind=run). */
  runId?: string;
  /** Set on `script` channel — bound to a single ScriptRegistry handle. */
  scriptId?: string;
  /** Set on `events` channel when `?scope=...` parses cleanly. */
  scope?: EventsScope;
  unsubscribe?: () => void;
}

export function parseScope(raw: string | null): EventsScope | null {
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx < 1) return null;
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!id) return null;
  if (
    kind === "run" ||
    kind === "project" ||
    kind === "audit" ||
    kind === "plan" ||
    kind === "decision" ||
    kind === "feedback"
  ) {
    return { kind, id };
  }
  return null;
}

/**
 * Decide whether a request is a WebSocket upgrade we recognize. If so, attach
 * `data` describing the channel; the upgrade itself is performed by the caller
 * via `server.upgrade(req, { data })`.
 */
export function planWsUpgrade(
  req: Request,
  ctx: DaemonContext,
):
  | { kind: "skip" }
  | { kind: "deny"; status: number; reason: string }
  | { kind: "upgrade"; data: WsClientData } {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/ws/")) return { kind: "skip" };

  const channelName = url.pathname.replace(/^\/ws\//, "");
  if (
    channelName !== "events" &&
    channelName !== "pane" &&
    channelName !== "inbox" &&
    channelName !== "script"
  ) {
    return { kind: "deny", status: 404, reason: "unknown ws channel" };
  }

  if (!authorizeRequest(req, ctx.config)) {
    return { kind: "deny", status: 401, reason: "unauthorized" };
  }

  if (channelName === "pane") {
    const runId = url.searchParams.get("runId");
    if (!runId) return { kind: "deny", status: 400, reason: "runId required" };
    return { kind: "upgrade", data: { channel: "pane", runId } };
  }

  if (channelName === "script") {
    const scriptId = url.searchParams.get("scriptId");
    if (!scriptId) return { kind: "deny", status: 400, reason: "scriptId required" };
    return { kind: "upgrade", data: { channel: "script", scriptId } };
  }

  if (channelName === "events") {
    // New: `?scope=run:X` / `?scope=project:X` / etc.
    // Legacy: `?runId=X` is mapped to `scope=run:X`.
    const scopeRaw = url.searchParams.get("scope");
    const scope = parseScope(scopeRaw);
    if (scope) {
      return {
        kind: "upgrade",
        data: { channel: "events", scope, runId: scope.kind === "run" ? scope.id : undefined },
      };
    }
    const runId = url.searchParams.get("runId");
    if (runId) {
      return {
        kind: "upgrade",
        data: { channel: "events", scope: { kind: "run", id: runId }, runId },
      };
    }
    return { kind: "deny", status: 400, reason: "scope or runId required" };
  }

  return { kind: "upgrade", data: { channel: "inbox" } };
}

/**
 * Per-connection cache resolving (audit|plan|run)Id → projectId. Project rows
 * never change their parent plan/audit/run mapping, so a hit is permanently
 * valid for the connection's lifetime. A miss resolves once and is cached as
 * `null`.
 */
class ProjectIdResolver {
  private cache = new Map<string, string | null>();

  constructor(private db: Db) {}

  async resolve(kind: "audit" | "plan" | "run", id: string): Promise<string | null> {
    const key = `${kind}:${id}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;

    let projectId: string | null = null;
    try {
      if (kind === "audit") {
        const row = await this.db
          .select({ projectId: schema.audits.projectId })
          .from(schema.audits)
          .where(eq(schema.audits.id, id))
          .get();
        projectId = row?.projectId ?? null;
      } else if (kind === "plan") {
        const row = await this.db
          .select({ projectId: schema.plans.projectId })
          .from(schema.plans)
          .where(eq(schema.plans.id, id))
          .get();
        projectId = row?.projectId ?? null;
      } else if (kind === "run") {
        const row = await this.db
          .select({ projectId: schema.runs.projectId })
          .from(schema.runs)
          .where(eq(schema.runs.id, id))
          .get();
        projectId = row?.projectId ?? null;
      }
    } catch {
      // tolerate transient db errors — let the next event re-attempt
      return null;
    }
    this.cache.set(key, projectId);
    return projectId;
  }
}

/** Direct projectId carried on the event, when present. */
function eventProjectId(e: DaemonEvent): string | null {
  if (e.channel === "events" || e.channel === "inbox") {
    const maybe = (e as { projectId?: string | null }).projectId;
    if (typeof maybe === "string" && maybe.length > 0) return maybe;
  }
  return null;
}

/** Identifiers on the event we can resolve to a projectId via the DB cache. */
function eventIdentifiers(e: DaemonEvent): { runId?: string; auditId?: string; planId?: string } {
  const out: { runId?: string; auditId?: string; planId?: string } = {};
  if (e.channel === "events") {
    if (typeof (e as { runId?: string }).runId === "string") {
      out.runId = (e as { runId: string }).runId;
    }
  } else if (e.channel === "inbox") {
    const k = (e as { kind: string }).kind;
    if (k.startsWith("audit_") || k === "finding_promoted") {
      const auditId = (e as { auditId?: string }).auditId;
      if (auditId) out.auditId = auditId;
    }
    if (k.startsWith("plan_")) {
      const planId = (e as { planId?: string }).planId;
      if (planId) out.planId = planId;
    }
  }
  return out;
}

/**
 * Wire a freshly-opened WebSocket to the EventBus per its declared channel
 * and scope.
 */
export function attachWsChannel(ws: ServerWebSocket<WsClientData>, ctx: DaemonContext): void {
  const { channel, scope } = ws.data;
  const resolver = new ProjectIdResolver(ctx.db);

  const matchesScope = async (e: DaemonEvent): Promise<boolean> => {
    if (!scope) return false;
    if (scope.kind === "run") {
      if (e.channel !== "events") return false;
      const evRunId = (e as { runId?: string }).runId;
      return evRunId === scope.id;
    }
    if (scope.kind === "audit") {
      if (e.channel !== "inbox") return false;
      const evAuditId = (e as { auditId?: string }).auditId;
      return evAuditId === scope.id;
    }
    if (scope.kind === "plan") {
      if (e.channel !== "inbox") return false;
      const evPlanId = (e as { planId?: string }).planId;
      return evPlanId === scope.id;
    }
    if (scope.kind === "decision") {
      if (e.channel !== "inbox") return false;
      const evDecisionId = (e as { decisionId?: string }).decisionId;
      return evDecisionId === scope.id;
    }
    if (scope.kind === "feedback") {
      if (e.channel !== "inbox") return false;
      const evFeedbackId = (e as { feedbackId?: string }).feedbackId;
      return evFeedbackId === scope.id;
    }
    if (scope.kind === "project") {
      const direct = eventProjectId(e);
      if (direct === scope.id) return true;
      const ids = eventIdentifiers(e);
      if (ids.runId) {
        const pid = await resolver.resolve("run", ids.runId);
        if (pid === scope.id) return true;
      }
      if (ids.auditId) {
        const pid = await resolver.resolve("audit", ids.auditId);
        if (pid === scope.id) return true;
      }
      if (ids.planId) {
        const pid = await resolver.resolve("plan", ids.planId);
        if (pid === scope.id) return true;
      }
      return false;
    }
    return false;
  };

  const unsubscribe = ctx.events.subscribe((e) => {
    try {
      if (channel === "pane" && e.channel === "pane" && e.runId === ws.data.runId) {
        ws.send(e.bytes);
        return;
      }
      if (channel === "script" && e.channel === "script" && e.scriptId === ws.data.scriptId) {
        ws.send(e.bytes);
        return;
      }
      if (channel === "inbox" && e.channel === "inbox") {
        ws.send(JSON.stringify(e));
        return;
      }
      if (channel === "events") {
        // Async match — fire-and-forget; ordering within a single subscriber is
        // preserved since the EventBus iterates listeners synchronously and we
        // only `await` inside the per-event matcher.
        void matchesScope(e).then((matches) => {
          if (matches) {
            try {
              ws.send(JSON.stringify(e));
            } catch {
              // swallow send errors; close handler cleans up
            }
          }
        });
      }
    } catch {
      // ignore send errors; the close handler will clean up
    }
  });

  ws.data.unsubscribe = unsubscribe;
}

export function detachWsChannel(ws: ServerWebSocket<WsClientData>): void {
  ws.data.unsubscribe?.();
  ws.data.unsubscribe = undefined;
}
