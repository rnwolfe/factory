import { createHmac, timingSafeEqual } from "node:crypto";
import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import { type DialogProject, runDecisionReply } from "../decisions/dialog.ts";
import type { EventBus } from "../events.ts";
import { addCommentReaction } from "../projects/github-task-store.ts";
import { parseGithubRepo } from "./app-auth.ts";
import {
  appendOperatorComment,
  BOT_COMMENT_MARKER,
  type IssueIntakeProject,
  runIssueConversationReply,
  runIssueIntakeReply,
} from "./issue-triage.ts";

/**
 * GitHub App webhook handling (ADR-007 Phase 3). The App has one app-level
 * webhook, so with the App installed on all the operator's repos this endpoint
 * receives `issues` / `issue_comment` events for EVERY repo — most of which
 * Factory doesn't track. Every delivery is gated against a github-issues-backed
 * project for the repo; unmatched deliveries are a fast no-op (acked 200 so
 * GitHub doesn't retry or disable the hook).
 */

const FACTORY_LABEL = "factory";

/** author_association values that imply repo write-access. */
const WRITE_ASSOC = new Set(["OWNER", "COLLABORATOR", "MEMBER"]);

/**
 * Gate for whether the App should answer an inbound issue comment. An author
 * passes if their login is on the operator-configured allowlist OR they have
 * repo write-access (author_association). Empty allowlist + no write-access =
 * the bot stays silent — replies are outward-facing public posts, so this is
 * deny-by-default. The `[bot]`/marker loop guard runs earlier in
 * `classifyWebhook`; this is the trust gate, not the loop gate.
 */
export function isAllowedReplyAuthor(
  author: string,
  authorAssociation: string,
  allowlist: readonly string[],
): boolean {
  if (WRITE_ASSOC.has(authorAssociation)) return true;
  return allowlist.includes(author.trim().toLowerCase());
}

export interface GithubWebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  issue?: {
    number?: number;
    title?: string;
    body?: string;
    html_url?: string;
    user?: { login?: string };
    labels?: Array<{ name: string } | string>;
    pull_request?: unknown;
  };
  comment?: {
    id?: number;
    body?: string;
    user?: { login?: string };
    /** OWNER | COLLABORATOR | MEMBER | CONTRIBUTOR | NONE | … */
    author_association?: string;
  };
  sender?: { login?: string };
}

export interface WebhookResult {
  status: "ignored" | "processed";
  reason: string;
  projectId?: string;
  /** Present when an externally-authored issue should be offered for intake. */
  intake?: { number: number; title: string; author: string; htmlUrl?: string; body?: string };
  /** Present for an inbound human comment on a tracked issue (task-048). */
  comment?: {
    number: number;
    /** The comment's own id — for reacting (👀) to it. 0 if absent. */
    commentId: number;
    author: string;
    body: string;
    authorAssociation: string;
  };
  /**
   * Present when a tracked issue's open/closed state changed on GitHub. The
   * github-issues store derives task status live from issue state, so there's
   * nothing to write back — this just drives a live refresh event so a
   * GitHub-closed task drops off the Factory board without waiting for the poll.
   */
  taskUpdate?: { number: number; action: "closed" | "reopened" };
}

/** Timing-safe verification of the `X-Hub-Signature-256` header. */
export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface RepoProject {
  id: string;
  githubRemote: string | null;
  taskBackend?: string | null;
}

/**
 * Pure classification of a delivery against the known projects. Returns
 * `ignored` for installation/other events, repos with no github-issues-backed
 * project, and PRs (which share the issues stream). Only matched issue/comment
 * events are `processed`.
 */
export function classifyWebhook(
  event: string,
  payload: GithubWebhookPayload,
  projects: RepoProject[],
): WebhookResult {
  if (event === "installation" || event === "installation_repositories") {
    return { status: "ignored", reason: "installation event" };
  }
  if (event !== "issues" && event !== "issue_comment") {
    return { status: "ignored", reason: `unhandled event: ${event}` };
  }
  const fullName = payload.repository?.full_name;
  if (!fullName) return { status: "ignored", reason: "no repository in payload" };

  const project = projects.find((p) => {
    if (p.taskBackend !== "github-issues" || !p.githubRemote) return false;
    const repo = parseGithubRepo(p.githubRemote);
    return repo != null && `${repo.owner}/${repo.repo}` === fullName;
  });
  if (!project) return { status: "ignored", reason: `repo ${fullName} not integrated` };

  if (event === "issues" && payload.issue?.pull_request) {
    return { status: "ignored", reason: "pull request, not an issue" };
  }

  if (event === "issues" && payload.action === "opened") {
    const factoryAuthored = (payload.issue?.labels ?? []).some(
      (l) => (typeof l === "string" ? l : l.name) === FACTORY_LABEL,
    );
    if (factoryAuthored) {
      return {
        status: "processed",
        reason: "factory-authored issue opened",
        projectId: project.id,
      };
    }
    return {
      status: "processed",
      reason: `external issue #${payload.issue?.number} — intake`,
      projectId: project.id,
      intake: {
        number: payload.issue?.number ?? 0,
        title: payload.issue?.title ?? "(untitled)",
        author: payload.issue?.user?.login ?? payload.sender?.login ?? "unknown",
        ...(payload.issue?.html_url ? { htmlUrl: payload.issue.html_url } : {}),
        ...(payload.issue?.body ? { body: payload.issue.body } : {}),
      },
    };
  }

  // A tracked issue closed/reopened on GitHub. The store reads status live, so
  // no writeback is needed — surface it so the daemon publishes a project-scoped
  // refresh event and the closed task leaves the active board immediately.
  if (event === "issues" && (payload.action === "closed" || payload.action === "reopened")) {
    if (payload.issue?.number == null) {
      return { status: "ignored", reason: `issue ${payload.action} without a number` };
    }
    return {
      status: "processed",
      reason: `issue #${payload.issue.number} ${payload.action}`,
      projectId: project.id,
      taskUpdate: { number: payload.issue.number, action: payload.action },
    };
  }

  // Inbound human comment on a tracked issue — route to the issue_intake
  // thread for an agent reply (task-048). Loop guard: ignore the bot's own
  // echoed comments (marker) and any `[bot]` author, so factory's replies
  // don't re-trigger triage.
  if (event === "issue_comment" && payload.action === "created") {
    const commentBody = payload.comment?.body ?? "";
    const author = payload.comment?.user?.login ?? "";
    const isBot = author.endsWith("[bot]") || commentBody.includes(BOT_COMMENT_MARKER);
    if (isBot) {
      return { status: "ignored", reason: "bot-authored comment (loop guard)" };
    }
    if (payload.issue?.number == null) {
      return { status: "ignored", reason: "comment without an issue number" };
    }
    return {
      status: "processed",
      reason: `issue_comment on #${payload.issue.number}`,
      projectId: project.id,
      comment: {
        number: payload.issue.number,
        commentId: payload.comment?.id ?? 0,
        author: author || payload.sender?.login || "unknown",
        body: commentBody,
        authorAssociation: payload.comment?.author_association ?? "NONE",
      },
    };
  }

  return { status: "processed", reason: `${event}.${payload.action ?? ""}`, projectId: project.id };
}

/**
 * Fetch the project set, classify, and perform the side effect: an
 * externally-opened issue on an integrated repo becomes an `issue_intake`
 * decision in the inbox (operator approves → adopt as a task; dismiss →
 * ignore). Preserves the inbox-as-only-attention-sink contract — external
 * input never silently becomes runnable work.
 */
export async function handleGithubWebhook(
  deps: { db: Db; events: EventBus; config?: FactoryConfig },
  event: string,
  payload: GithubWebhookPayload,
): Promise<WebhookResult> {
  const { db, events, config } = deps;
  const projects = await db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      workdirPath: schema.projects.workdirPath,
      agent: schema.projects.agent,
      githubRemote: schema.projects.githubRemote,
      githubInstallationId: schema.projects.githubInstallationId,
      taskBackend: schema.projects.taskBackend,
    })
    .from(schema.projects)
    .all();
  const result = classifyWebhook(event, payload, projects);

  if (result.status === "processed" && result.intake && result.projectId) {
    const project = projects.find((p) => p.id === result.projectId);
    const decisionId = createId();
    await db.insert(schema.decisions).values({
      id: decisionId,
      kind: "issue_intake",
      projectId: result.projectId,
      outcome: "intake",
      payload: {
        number: result.intake.number,
        title: result.intake.title,
        author: result.intake.author,
        ...(result.intake.htmlUrl ? { htmlUrl: result.intake.htmlUrl } : {}),
        ...(result.intake.body ? { body: result.intake.body } : {}),
      },
      status: "pending",
      createdAt: Date.now(),
    });
    events.publish({
      channel: "inbox",
      kind: "decision_created",
      decisionId,
      projectId: result.projectId,
    });

    // Auto-triage on landing (task-048): produce a plan/task suggestion and
    // echo it to the issue, matching the file backend's inbox behavior.
    // Fire-and-forget; the reply broadcasts over /ws/inbox when it lands.
    if (config && project) {
      fireIssueIntakeReply({ db, events, config, project }, decisionId);
    }
  }

  // A tracked issue closed/reopened on GitHub: nothing to write back (status is
  // derived from issue state on read), just nudge the project's task list to
  // refetch so the closed task drops off the active board live.
  if (result.status === "processed" && result.taskUpdate && result.projectId) {
    events.publish({
      channel: "events",
      kind: "task_updated",
      projectId: result.projectId,
      taskId: String(result.taskUpdate.number),
      action: result.taskUpdate.action,
    });
  }

  // Inbound human comment on a tracked issue: append to the matching decision
  // thread and let the agent reply. An externally-opened issue routes to its
  // `issue_intake` thread (task-048); a github-backed task's issue (whose
  // number IS the task id) routes to a pending `blocked_run`/`agent_decision`
  // decision so the operator can answer the agent from GitHub itself.
  if (result.status === "processed" && result.comment && result.projectId && config) {
    const project = projects.find((p) => p.id === result.projectId);
    // Trust gate: only answer comments from allowlisted logins or repo
    // collaborators. Applies to both the decision-thread reply and the
    // free-form conversational reply — replies post publicly on GitHub.
    const allowed = isAllowedReplyAuthor(
      result.comment.author,
      result.comment.authorAssociation,
      config.githubReplyAllowlist,
    );
    if (project && allowed) {
      // Acknowledge the comment we're about to act on with a 👀 reaction.
      // Fire-and-forget; a reaction failure must never hold up the reply.
      if (result.comment.commentId > 0) {
        const commentId = result.comment.commentId;
        void addCommentReaction(config, project, commentId, "eyes").catch(() => false);
      }
      const decision = await findDecisionForIssue(db, result.projectId, result.comment.number);
      if (decision) {
        await appendOperatorComment(db, decision.id, result.comment.body);
        events.publish({
          channel: "inbox",
          kind: "comment_added",
          decisionId: decision.id,
          role: "operator",
        });
        if (decision.kind === "issue_intake") {
          fireIssueIntakeReply({ db, events, config, project }, decision.id);
        } else {
          fireDecisionReply({ db, events, config, project }, decision.id);
        }
      } else {
        // No pending decision card — a free-form reply on a tracked issue.
        // Answer statelessly from the live issue thread + project context.
        fireIssueConversationReply({ db, events, config, project }, result.comment.number);
      }
    } else if (project && !allowed) {
      console.log(
        `[webhook] issue_comment on #${result.comment.number} from @${result.comment.author} ignored (not allowlisted)`,
      );
    }
  }

  return result;
}

/**
 * Find the pending decision an inbound issue comment belongs to. An
 * `issue_intake` decision keys off `payload.number` (the externally-opened
 * issue). A github-backed task's `blocked_run`/`agent_decision` decision keys
 * off `payload.taskId` — which, for the github-issues backend, IS the issue
 * number. issue_intake wins when both match (it's the externally-filed issue
 * not yet adopted as a task).
 */
async function findDecisionForIssue(
  db: Db,
  projectId: string,
  issueNumber: number,
): Promise<{ id: string; kind: string } | null> {
  const rows = await db
    .select({
      id: schema.decisions.id,
      kind: schema.decisions.kind,
      payload: schema.decisions.payload,
    })
    .from(schema.decisions)
    .where(and(eq(schema.decisions.projectId, projectId), eq(schema.decisions.status, "pending")))
    .all();
  const intake = rows.find(
    (r) => r.kind === "issue_intake" && (r.payload as { number?: number })?.number === issueNumber,
  );
  if (intake) return { id: intake.id, kind: intake.kind };
  const task = rows.find(
    (r) =>
      (r.kind === "blocked_run" || r.kind === "agent_decision") &&
      (r.payload as { taskId?: string | null })?.taskId === String(issueNumber),
  );
  return task ? { id: task.id, kind: task.kind } : null;
}

/** Fire-and-forget the blocked_run/agent_decision reply, surfacing the events. */
function fireDecisionReply(
  deps: { db: Db; events: EventBus; config: FactoryConfig; project: DialogProject },
  decisionId: string,
): void {
  void (async () => {
    try {
      await runDecisionReply(deps, decisionId);
      deps.events.publish({ channel: "inbox", kind: "comment_added", decisionId, role: "agent" });
      deps.events.publish({ channel: "inbox", kind: "decision_updated", decisionId });
    } catch (err) {
      console.error(
        `[decision-reply] ${decisionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

/**
 * Fire-and-forget a free-form conversational reply on a tracked issue that has
 * no pending decision. Stateless: the reply reads the live GitHub thread for
 * context and posts straight back to the issue — nothing lands in the inbox.
 */
function fireIssueConversationReply(
  deps: { db: Db; events: EventBus; config: FactoryConfig; project: IssueIntakeProject },
  issueNumber: number,
): void {
  void (async () => {
    try {
      await runIssueConversationReply(deps, issueNumber);
    } catch (err) {
      console.error(
        `[issue-conversation] #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

/** Fire-and-forget the issue-intake reply, surfacing the agent reply event. */
function fireIssueIntakeReply(
  deps: { db: Db; events: EventBus; config: FactoryConfig; project: IssueIntakeProject },
  decisionId: string,
): void {
  void (async () => {
    try {
      await runIssueIntakeReply(deps, decisionId);
      deps.events.publish({ channel: "inbox", kind: "comment_added", decisionId, role: "agent" });
      deps.events.publish({ channel: "inbox", kind: "decision_updated", decisionId });
    } catch (err) {
      console.error(
        `[issue-triage] ${decisionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

/**
 * HTTP route for `POST /webhooks/github`. Verifies the HMAC, classifies, and
 * always acks 200 for verified deliveries (ignored or processed) so GitHub
 * doesn't retry; 401 only on a bad/missing signature, 503 when unconfigured.
 */
export async function githubWebhookRoute(
  req: Request,
  config: FactoryConfig,
  db: Db,
  events: EventBus,
): Promise<Response> {
  const secret = config.githubApp?.webhookSecret;
  if (!secret) return new Response("github webhook not configured", { status: 503 });
  const raw = await req.text();
  if (!verifyGithubSignature(secret, raw, req.headers.get("x-hub-signature-256"))) {
    return new Response("bad signature", { status: 401 });
  }
  const event = req.headers.get("x-github-event") ?? "unknown";
  let payload: GithubWebhookPayload;
  try {
    payload = JSON.parse(raw) as GithubWebhookPayload;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const result = await handleGithubWebhook({ db, events, config }, event, payload);
  console.log(`[webhook] ${event}.${payload.action ?? ""} → ${result.status}: ${result.reason}`);
  return Response.json({ ok: true, ...result }, { status: 200 });
}
