import { createHmac, timingSafeEqual } from "node:crypto";
import { type Db, schema } from "@factory/db";
import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import { parseGithubRepo } from "./app-auth.ts";
import {
  appendOperatorComment,
  BOT_COMMENT_MARKER,
  type IssueIntakeProject,
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
    body?: string;
    user?: { login?: string };
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
  comment?: { number: number; author: string; body: string };
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
        author: author || payload.sender?.login || "unknown",
        body: commentBody,
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

  // Inbound human comment on a tracked issue: append to the matching
  // issue_intake thread and let the agent reply (task-048).
  if (result.status === "processed" && result.comment && result.projectId && config) {
    const project = projects.find((p) => p.id === result.projectId);
    const decision = await findIssueIntakeDecision(db, result.projectId, result.comment.number);
    if (decision && project) {
      await appendOperatorComment(db, decision.id, result.comment.body);
      events.publish({
        channel: "inbox",
        kind: "comment_added",
        decisionId: decision.id,
        role: "operator",
      });
      fireIssueIntakeReply({ db, events, config, project }, decision.id);
    }
  }

  return result;
}

/** Find the pending issue_intake decision for a given project + issue number. */
async function findIssueIntakeDecision(
  db: Db,
  projectId: string,
  issueNumber: number,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: schema.decisions.id, payload: schema.decisions.payload })
    .from(schema.decisions)
    .where(
      and(
        eq(schema.decisions.kind, "issue_intake"),
        eq(schema.decisions.projectId, projectId),
        eq(schema.decisions.status, "pending"),
      ),
    )
    .all();
  const match = rows.find((r) => (r.payload as { number?: number })?.number === issueNumber);
  return match ? { id: match.id } : null;
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
