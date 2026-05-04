import type { RuntimeEvent } from "@factory/runtime";

/**
 * Daemon-only event, broadcast on /ws/events alongside RuntimeEvents but
 * not produced by `runtime.spawn`. Used for post-spawn signals like the
 * quality report that lands after the agent's auto-commit.
 */
export type DaemonRunEvent = {
  kind: "quality_report";
  runId: string;
  iteration: number;
  overall: "pass" | "fail" | "skipped";
};

export type DaemonEvent =
  | ({ channel: "events" } & RuntimeEvent)
  | ({ channel: "events" } & DaemonRunEvent)
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
  | {
      channel: "inbox";
      kind: "plan_created";
      planId: string;
      planKind: "project_spec" | "task_plan" | "refinement" | "feature_plan";
      projectId?: string | null;
    }
  | { channel: "inbox"; kind: "plan_updated"; planId: string }
  | {
      channel: "inbox";
      kind: "plan_comment_added";
      planId: string;
      role: "operator" | "agent";
    }
  | {
      channel: "inbox";
      kind: "plan_frozen";
      planId: string;
      projectId?: string | null;
      taskId?: string | null;
    }
  | { channel: "inbox"; kind: "plan_abandoned"; planId: string }
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
