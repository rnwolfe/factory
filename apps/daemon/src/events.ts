import type { RuntimeEvent } from "@factory/runtime";

/**
 * Daemon-only event, broadcast on /ws/events alongside RuntimeEvents but
 * not produced by `runtime.spawn`. Used for post-spawn signals like the
 * quality report that lands after the agent's auto-commit.
 */
export type DaemonRunEvent =
  | {
      kind: "quality_report";
      runId: string;
      iteration: number;
      overall: "pass" | "fail" | "skipped";
    }
  | {
      kind: "deferred_task_started";
      runId: string;
      deferredTaskId: string;
      summary: string;
    }
  | {
      kind: "deferred_task_completed";
      runId: string;
      deferredTaskId: string;
      exitCode: number;
      continuationRunId: string;
    }
  | {
      kind: "deferred_task_orphaned";
      runId: string;
      deferredTaskId: string;
      pid: number | null;
    };

/**
 * `projectId` is attached opportunistically at publish sites so that the
 * scoped `/ws/events?scope=project:<id>` channel can fan out without a
 * per-event DB lookup. Variants where the publisher doesn't have the
 * project in scope simply omit it; the project channel ignores them.
 */
export type DaemonEvent =
  | ({ channel: "events"; projectId?: string | null } & RuntimeEvent)
  | ({ channel: "events"; projectId?: string | null } & DaemonRunEvent)
  | {
      /**
       * A task's open/closed state changed outside Factory — currently a
       * GitHub-Issues-backed task whose issue was closed or reopened on GitHub
       * (see `github/webhook.ts`). Carries `projectId` so the project-scoped
       * `/ws/events` channel refetches the task list live instead of waiting
       * for the slow poll. No `runId`, so the global `ops` scope ignores it.
       */
      channel: "events";
      kind: "task_updated";
      projectId: string;
      taskId: string;
      action: "closed" | "reopened";
    }
  | { channel: "inbox"; kind: "idea_captured"; ideaId: string }
  | {
      channel: "inbox";
      kind: "decision_created";
      decisionId: string;
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "decision_actioned";
      decisionId: string;
      projectId?: string | null;
    }
  | {
      /**
       * An adjusted (non-ratified) agent_decision must resurface for
       * implementation rather than silently closing. Fired alongside
       * `decision_actioned` whenever the operator overrides — never on
       * ratification. See `decisions/resurface.ts` (task-061).
       */
      channel: "inbox";
      kind: "decision_resurfaced";
      decisionId: string;
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "decision_updated";
      decisionId: string;
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "comment_added";
      decisionId: string;
      role: "operator" | "agent";
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "plan_created";
      planId: string;
      planKind:
        | "project_spec"
        | "task_plan"
        | "refinement"
        | "feature_plan"
        | "project_vision"
        | "task_template";
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "plan_updated";
      planId: string;
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "plan_comment_added";
      planId: string;
      role: "operator" | "agent";
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "plan_frozen";
      planId: string;
      projectId?: string | null;
      taskId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "plan_abandoned";
      planId: string;
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "plan_superseded";
      planId: string;
      supersededBy: string;
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "audit_started";
      auditId: string;
      projectId: string;
      skillName: string;
    }
  | { channel: "inbox"; kind: "audit_completed"; auditId: string; projectId: string }
  | {
      channel: "inbox";
      kind: "audit_approved";
      auditId: string;
      projectId: string;
      reportPath: string;
    }
  | { channel: "inbox"; kind: "audit_rejected"; auditId: string; projectId: string }
  | {
      channel: "inbox";
      kind: "audit_updated";
      auditId: string;
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "finding_promoted";
      auditId: string;
      findingId: string;
      promotedTo: { kind: "plan" | "task"; id: string };
      projectId?: string | null;
    }
  | {
      channel: "inbox";
      kind: "feedback_created";
      feedbackId: string;
    }
  | {
      channel: "inbox";
      kind: "feedback_updated";
      feedbackId: string;
    }
  | {
      channel: "inbox";
      kind: "feedback_comment_added";
      feedbackId: string;
      role: "operator" | "agent";
    }
  | {
      channel: "inbox";
      kind: "session_started";
      sessionId: string;
      projectId: string;
    }
  | {
      channel: "inbox";
      kind: "session_ended";
      sessionId: string;
      projectId: string;
      status: "ended" | "merged" | "merge_failed" | "aborted";
      commitCount: number;
    }
  | { channel: "pane"; runId: string; bytes: Uint8Array }
  | { channel: "script"; scriptId: string; bytes: Uint8Array };

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
