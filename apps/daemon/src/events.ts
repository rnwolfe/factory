import type { RuntimeEvent } from "@factory/runtime";

export type DaemonEvent =
  | ({ channel: "events" } & RuntimeEvent)
  | { channel: "inbox"; kind: "idea_captured"; ideaId: string }
  | { channel: "inbox"; kind: "decision_created"; decisionId: string }
  | { channel: "inbox"; kind: "decision_actioned"; decisionId: string }
  | { channel: "inbox"; kind: "decision_updated"; decisionId: string }
  | {
      channel: "inbox";
      kind: "comment_added";
      decisionId: string;
      role: "operator" | "agent";
    }
  | { channel: "pane"; runId: string; bytes: Uint8Array };

type Listener = (e: DaemonEvent) => void;

/**
 * In-process pub/sub used by WebSocket handlers. Lightweight; no buffering.
 * Late subscribers do not receive past events — they catch up via the events
 * table on connect.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  publish(e: DaemonEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // never let one listener kill the bus
      }
    }
  }

  size(): number {
    return this.listeners.size;
  }
}
