import { createHmac, timingSafeEqual } from "node:crypto";
import { type Db, schema } from "@factory/db";
import type { FactoryConfig } from "../config.ts";
import { parseGithubRepo } from "./app-auth.ts";

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
    user?: { login?: string };
    labels?: Array<{ name: string } | string>;
    pull_request?: unknown;
  };
  sender?: { login?: string };
}

export interface WebhookResult {
  status: "ignored" | "processed";
  reason: string;
  projectId?: string;
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
    return {
      status: "processed",
      reason: factoryAuthored
        ? "factory-authored issue opened"
        : `external issue #${payload.issue?.number} — intake pending`,
      projectId: project.id,
    };
  }

  return { status: "processed", reason: `${event}.${payload.action ?? ""}`, projectId: project.id };
}

/** Fetch the project set and classify (thin DB wrapper over `classifyWebhook`). */
export async function handleGithubWebhook(
  db: Db,
  event: string,
  payload: GithubWebhookPayload,
): Promise<WebhookResult> {
  const projects = await db
    .select({
      id: schema.projects.id,
      githubRemote: schema.projects.githubRemote,
      taskBackend: schema.projects.taskBackend,
    })
    .from(schema.projects)
    .all();
  return classifyWebhook(event, payload, projects);
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
  const result = await handleGithubWebhook(db, event, payload);
  console.log(`[webhook] ${event}.${payload.action ?? ""} → ${result.status}: ${result.reason}`);
  return Response.json({ ok: true, ...result }, { status: 200 });
}
