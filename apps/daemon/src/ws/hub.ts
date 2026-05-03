import type { ServerWebSocket } from "bun";
import { authorizeRequest } from "../auth.ts";
import type { DaemonContext } from "../context.ts";

export type WsChannel = "events" | "pane" | "inbox";

export interface WsClientData {
  channel: WsChannel;
  runId?: string;
  unsubscribe?: () => void;
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
  if (channelName !== "events" && channelName !== "pane" && channelName !== "inbox") {
    return { kind: "deny", status: 404, reason: "unknown ws channel" };
  }

  if (!authorizeRequest(req, ctx.config)) {
    return { kind: "deny", status: 401, reason: "unauthorized" };
  }

  if (channelName === "events" || channelName === "pane") {
    const runId = url.searchParams.get("runId");
    if (!runId) return { kind: "deny", status: 400, reason: "runId required" };
    return { kind: "upgrade", data: { channel: channelName, runId } };
  }

  return { kind: "upgrade", data: { channel: channelName } };
}

/**
 * Wire a freshly-opened WebSocket to the EventBus per its declared channel.
 */
export function attachWsChannel(ws: ServerWebSocket<WsClientData>, ctx: DaemonContext): void {
  const { channel, runId } = ws.data;

  const unsubscribe = ctx.events.subscribe((e) => {
    try {
      if (channel === "events" && e.channel === "events" && e.runId === runId) {
        ws.send(JSON.stringify(e));
      } else if (channel === "inbox" && e.channel === "inbox") {
        ws.send(JSON.stringify(e));
      } else if (channel === "pane" && e.channel === "pane" && e.runId === runId) {
        ws.send(e.bytes);
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
