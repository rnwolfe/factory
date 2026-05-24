import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getToken } from "./auth.ts";

export type ChannelScope =
  | { kind: "run"; id: string }
  | { kind: "project"; id: string }
  | { kind: "audit"; id: string }
  | { kind: "plan"; id: string }
  | { kind: "decision"; id: string }
  | { kind: "feedback"; id: string }
  /** Global ops dashboard subscription — id is the empty string. */
  | { kind: "ops"; id: "" };

export type ConnectionState = "connecting" | "open" | "closed";

interface UseChannelOpts {
  /** React Query key prefixes to invalidate on every event the scope matches. */
  invalidate: ReadonlyArray<readonly unknown[]>;
  /** Optional consumer that receives the parsed event for fine-grained handling. */
  onEvent?: (event: unknown) => void;
  /** Called when the connection state changes. Used by the live indicator. */
  onState?: (state: ConnectionState) => void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Open a scoped `/ws/events` subscription and invalidate `invalidate` query
 * keys on each matching event. Reconnects on close with exponential backoff
 * (1s, 2s, 4s, ... up to 30s). The hook is idempotent over scope changes —
 * a remounted scope tears the old socket down before opening a new one.
 */
export function useScopedChannel(scope: ChannelScope | null, opts: UseChannelOpts): void {
  const qc = useQueryClient();
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!scope) return;
    const token = getToken();
    if (!token) return;

    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({
        scope: `${scope.kind}:${scope.id}`,
        token,
      });
      const url = `${proto}://${location.host}/ws/events?${params.toString()}`;

      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      optsRef.current.onState?.("connecting");

      ws.onopen = () => {
        attempt = 0;
        optsRef.current.onState?.("open");
      };
      ws.onmessage = (msg) => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(typeof msg.data === "string" ? msg.data : "");
        } catch {
          // ignore non-JSON frames
        }
        for (const key of optsRef.current.invalidate) {
          qc.invalidateQueries({ queryKey: key as unknown[] });
        }
        if (parsed) optsRef.current.onEvent?.(parsed);
      };
      ws.onclose = () => {
        optsRef.current.onState?.("closed");
        scheduleReconnect();
      };
      ws.onerror = () => {
        // ignore — `onclose` runs after and triggers reconnect
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) ws.close();
    };
  }, [scope, qc]);
}

/**
 * Track the live connection state of a scoped channel. Used by the shell
 * header to render the "live" dot.
 */
export function useChannelState(scope: ChannelScope | null): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  useScopedChannel(scope, {
    invalidate: [],
    onState: setState,
  });
  return state;
}
