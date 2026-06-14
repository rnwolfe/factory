import type { Db } from "@factory/db";
import { schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { DaemonEvent, EventBus } from "../events.ts";

/**
 * Web Push notification payload shipped to enrolled browsers. The service
 * worker reads `title`/`body` directly into `showNotification`, uses `url`
 * to deep-link on click, and `tag` to coalesce repeated notifications for
 * the same target (e.g. multiple updates to the same decision should
 * replace, not stack).
 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * Translate a daemon EventBus event into a notification payload, or null
 * if the event isn't operator-attention-worthy. The autonomy filter for
 * `agent_decision` happens here too: when the originating project is in
 * `autonomous` mode, routine agent decisions are suppressed — the operator
 * opted out of those calls. Stop-the-line events (blocked_run,
 * merge_failure, run_failed) ignore autonomy and always push.
 */
export async function payloadFor(
  event: DaemonEvent,
  db: Db,
  config: FactoryConfig,
): Promise<PushPayload | null> {
  if (event.channel !== "inbox" && event.channel !== "events") return null;

  if (event.channel === "events") {
    if (event.kind !== "agent_exit") return null;
    // Failures push via decision_created (blocked_run, merge_failure, etc.).
    if (event.exitCode !== 0) return null;
    // Operator opt-in: auto-advance + 4-worker concurrency would otherwise
    // produce one push per completed run. Off by default.
    if (!config.notifyOnRunComplete) return null;

    const run = await db
      .select({ projectId: schema.runs.projectId, summary: schema.runs.summary })
      .from(schema.runs)
      .where(eq(schema.runs.id, event.runId))
      .get();
    if (!run) return null;

    const project = await db
      .select({ name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, run.projectId))
      .get();

    const projectName = project?.name ?? "project";
    const summary = run.summary?.trim();
    return {
      title: "run complete",
      body:
        summary && summary.length > 0
          ? `${projectName} · ${summary.slice(0, 140)}`
          : `${projectName} · run finished`,
      url: `/projects/${run.projectId}/runs/${event.runId}`,
      tag: `run:${event.runId}`,
    };
  }

  if (event.kind === "decision_created") {
    const decision = await db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, event.decisionId))
      .get();
    if (!decision) return null;

    // Autonomy filter applies only to routine agent_decision rows. A run
    // marked blocked or a merge failure is involuntary and should always
    // surface, regardless of mode.
    if (decision.kind === "agent_decision" && decision.projectId) {
      const project = await db
        .select({ autonomyMode: schema.projects.autonomyMode })
        .from(schema.projects)
        .where(eq(schema.projects.id, decision.projectId))
        .get();
      if (project?.autonomyMode === "autonomous") return null;
    }

    const { title, body } = describeDecision(decision);
    return {
      title,
      body,
      url: `/decisions/${event.decisionId}`,
      // Tag by decision id so re-emissions (decision_updated, comment_added)
      // replace rather than stack.
      tag: `decision:${event.decisionId}`,
    };
  }

  if (event.kind === "audit_completed") {
    return {
      title: "audit ready for review",
      body: "an audit run finished — review and approve or reject the report.",
      url: `/projects/${event.projectId}/audits/${event.auditId}`,
      tag: `audit:${event.auditId}`,
    };
  }

  if (event.kind === "session_ended" && event.status === "merge_failed") {
    return {
      title: "session merge failed",
      body: "an interactive session ended but couldn't merge — resolve manually.",
      url: `/projects/${event.projectId}/sessions/${event.sessionId}`,
      tag: `session:${event.sessionId}`,
    };
  }

  return null;
}

interface DecisionRow {
  kind: string;
  outcome: string | null;
  payload: unknown;
}

function describeDecision(d: DecisionRow): { title: string; body: string } {
  const outcome = (d.outcome ?? "").trim();
  if (d.kind === "blocked_run") {
    return {
      title: "run blocked",
      body: outcome.length > 0 ? outcome : "the agent stopped and is asking for guidance.",
    };
  }
  if (d.kind === "merge_failure") {
    return {
      title: "merge failed",
      body: outcome.length > 0 ? outcome : "a successful run couldn't merge to main.",
    };
  }
  if (d.kind === "agent_decision") {
    const summary =
      typeof (d.payload as { summary?: unknown })?.summary === "string"
        ? (d.payload as { summary: string }).summary.slice(0, 140)
        : outcome;
    return {
      title: "agent needs a decision",
      body: summary.length > 0 ? summary : "the agent paused for a design call.",
    };
  }
  if (d.kind === "triage") {
    return {
      title: "idea ready to triage",
      body: outcome.length > 0 ? outcome : "a captured idea finished triage.",
    };
  }
  if (d.kind === "tag_change") {
    return {
      title: "project tag changed",
      body: outcome.length > 0 ? outcome : "an automated tag change is awaiting review.",
    };
  }
  if (d.kind === "issue_intake") {
    const p = (d.payload ?? {}) as { number?: unknown; title?: unknown; author?: unknown };
    const num = typeof p.number === "number" ? `#${p.number} ` : "";
    const title = typeof p.title === "string" && p.title.length > 0 ? p.title : "new issue";
    const author = typeof p.author === "string" && p.author.length > 0 ? ` · @${p.author}` : "";
    return {
      title: "new GitHub issue",
      body: `${num}${title.slice(0, 120)}${author}`,
    };
  }
  return {
    title: "decision needs review",
    body: outcome.length > 0 ? outcome : "a new decision landed in the inbox.",
  };
}

/**
 * Wire the EventBus to web-push delivery. Subscribes once at daemon boot
 * and runs forever. On each matching event, fetches the targets from the
 * `push_subscriptions` table, encrypts + signs a payload per target, and
 * fires a POST to each push service in parallel. Subscriptions returning
 * 404/410 are pruned (the browser tells us they're dead). Other failures
 * are logged but don't tear down the dispatcher.
 *
 * Returns an unsubscribe handle. Caller is expected to call it on shutdown.
 */
export function startPushDispatcher(args: {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
}): () => void {
  const { config, db, events } = args;

  const dispatch = async (event: DaemonEvent) => {
    if (!config.vapid.publicKey || !config.vapid.privateKey) return;
    let payload: PushPayload | null;
    try {
      payload = await payloadFor(event, db, config);
    } catch (err) {
      console.warn(
        `[push] payload build failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!payload) return;

    const subs = await db.select().from(schema.pushSubscriptions).all();
    if (subs.length === 0) return;

    // Defer the import of web-push to first dispatch so daemons that
    // haven't yet generated a VAPID keypair don't pay the import cost.
    const { default: webpush } = await import("web-push");
    webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 60 * 60 * 24 },
          );
          await db
            .update(schema.pushSubscriptions)
            .set({ lastSeenAt: Date.now() })
            .where(eq(schema.pushSubscriptions.id, sub.id));
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            // Subscription was revoked or unsubscribed in-browser. Prune.
            await db
              .delete(schema.pushSubscriptions)
              .where(eq(schema.pushSubscriptions.id, sub.id));
          } else {
            console.warn(
              `[push] delivery failed (${status ?? "?"}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
    );
  };

  return events.subscribe((event) => {
    void dispatch(event);
  });
}
