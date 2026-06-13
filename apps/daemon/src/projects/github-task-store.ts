import YAML from "yaml";
import type { GithubAppClient } from "../github/app-auth.ts";
import { GithubError } from "./github.ts";
import type { CreateTaskInput, TaskFile, TaskFrontmatter, TaskStore } from "./tasks.ts";

/**
 * GitHub Issues task backend (ADR-007 Phase 2). The issue IS the task: its
 * title is the task title, its body carries the task markdown plus a hidden
 * `<!-- factory:task … -->` frontmatter block, and its open/closed state +
 * `status:*` label mirror the richer Factory status. Issue number is the task
 * id. Every Factory-managed issue carries the `factory` label.
 */

type FetchFn = typeof globalThis.fetch;
const API = "https://api.github.com";
const UA = "factory-daemon";
const API_VERSION = "2022-11-28";
const FACTORY_LABEL = "factory";

/** Fields persisted into the issue body's hidden frontmatter comment. */
const META_KEYS = [
  "status",
  "priority",
  "estimate",
  "model",
  "agent",
  "parent",
  "legacy_id",
] as const;

const META_RE = /<!--\s*factory:task\n([\s\S]*?)\n-->\n?([\s\S]*)$/;

interface IssueMeta {
  status?: TaskFrontmatter["status"];
  priority?: TaskFrontmatter["priority"];
  estimate?: TaskFrontmatter["estimate"];
  model?: string;
  agent?: string;
  parent?: string;
  legacy_id?: string;
}

/** Split an issue body into its Factory metadata + the human-visible body. */
export function parseTaskIssueBody(issueBody: string): { meta: IssueMeta; body: string } {
  const m = META_RE.exec(issueBody);
  if (!m) return { meta: {}, body: issueBody };
  const meta = (YAML.parse(m[1] ?? "") ?? {}) as IssueMeta;
  return { meta, body: (m[2] ?? "").replace(/^\s+/, "") };
}

/** Render a task into an issue body: hidden metadata comment + the body. */
export function renderTaskIssueBody(meta: IssueMeta, body: string): string {
  const picked: Record<string, unknown> = {};
  for (const k of META_KEYS) {
    const v = meta[k];
    if (v != null && v !== "") picked[k] = v;
  }
  const yaml = YAML.stringify(picked).trimEnd();
  return `<!-- factory:task\n${yaml}\n-->\n\n${body.trim()}\n`;
}

/** Factory status → GitHub issue state. Open statuses ride a `status:*` label. */
export function statusToGithub(status: TaskFrontmatter["status"]): {
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | null;
} {
  if (status === "done") return { state: "closed", stateReason: "completed" };
  if (status === "dropped") return { state: "closed", stateReason: "not_planned" };
  return { state: "open", stateReason: null };
}

/** Derive a Factory status from GitHub state when metadata doesn't carry one. */
function statusFromGithub(state: string, stateReason: string | null): TaskFrontmatter["status"] {
  if (state === "closed") return stateReason === "not_planned" ? "dropped" : "done";
  return "ready";
}

interface IssueApi {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

function labelNames(labels: IssueApi["labels"]): string[] {
  return labels.map((l) => (typeof l === "string" ? l : l.name));
}

function issueToTaskFile(owner: string, repo: string, issue: IssueApi): TaskFile {
  const { meta, body } = parseTaskIssueBody(issue.body ?? "");
  const status = meta.status ?? statusFromGithub(issue.state, issue.state_reason);
  const otherLabels = labelNames(issue.labels).filter(
    (n) => n !== FACTORY_LABEL && !n.startsWith("status:"),
  );
  const frontmatter: TaskFrontmatter = {
    id: String(issue.number),
    title: issue.title,
    status,
  };
  if (meta.priority) frontmatter.priority = meta.priority;
  if (meta.estimate) frontmatter.estimate = meta.estimate;
  if (meta.model) frontmatter.model = meta.model;
  if (meta.agent) frontmatter.agent = meta.agent;
  if (meta.parent) frontmatter.parent = meta.parent;
  if (meta.legacy_id) frontmatter.legacy_id = meta.legacy_id;
  if (otherLabels.length > 0) frontmatter.labels = otherLabels;
  return {
    id: String(issue.number),
    filePath: `github:${owner}/${repo}#${issue.number}`,
    frontmatter,
    body,
  };
}

export class GithubIssuesStore implements TaskStore {
  private installationId: number | null;

  constructor(
    private readonly client: GithubAppClient,
    private readonly owner: string,
    private readonly repo: string,
    installationId: number | null = null,
    private readonly fetchFn: FetchFn = globalThis.fetch,
  ) {
    this.installationId = installationId;
  }

  private async headers(): Promise<Record<string, string>> {
    if (this.installationId == null) {
      this.installationId = await this.client.installationId(this.owner, this.repo);
    }
    const token = await this.client.installationToken(this.installationId);
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  private base(): string {
    return `${API}/repos/${this.owner}/${this.repo}`;
  }

  private async fail(res: Response, what: string): Promise<never> {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new GithubError("rate_limited", `${what} failed (${res.status}): ${body}`);
    }
    throw new GithubError("network", `${what} failed (${res.status}): ${body}`);
  }

  async list(): Promise<TaskFile[]> {
    const headers = await this.headers();
    const out: TaskFile[] = [];
    for (let page = 1; page <= 10; page++) {
      const url = `${this.base()}/issues?state=all&labels=${FACTORY_LABEL}&per_page=100&page=${page}`;
      const res = await this.fetchFn(url, { headers });
      if (!res.ok) await this.fail(res, "list issues");
      const issues = (await res.json()) as IssueApi[];
      for (const issue of issues) {
        if (issue.pull_request) continue; // the issues endpoint also returns PRs
        out.push(issueToTaskFile(this.owner, this.repo, issue));
      }
      if (issues.length < 100) break;
    }
    out.sort((a, b) => Number(a.id) - Number(b.id));
    return out;
  }

  async read(taskId: string): Promise<TaskFile | null> {
    const headers = await this.headers();
    const res = await this.fetchFn(`${this.base()}/issues/${taskId}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, `read issue #${taskId}`);
    const issue = (await res.json()) as IssueApi;
    if (issue.pull_request) return null;
    return issueToTaskFile(this.owner, this.repo, issue);
  }

  async create(input: CreateTaskInput): Promise<TaskFile> {
    const headers = await this.headers();
    const status = input.status ?? "ready";
    const meta: IssueMeta = {
      status,
      priority: input.priority ?? "med",
      estimate: input.estimate ?? "small",
      model: input.model,
      agent: input.agent,
      parent: input.parent,
    };
    const labels = [FACTORY_LABEL, `status:${status}`, ...(input.labels ?? [])];
    const res = await this.fetchFn(`${this.base()}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: input.title || "Untitled",
        body: renderTaskIssueBody(meta, input.body),
        labels,
      }),
    });
    if (!res.ok) await this.fail(res, "create issue");
    const issue = (await res.json()) as IssueApi;
    return issueToTaskFile(this.owner, this.repo, issue);
  }

  async updateStatus(taskId: string, status: TaskFrontmatter["status"]): Promise<TaskFile | null> {
    const current = await this.read(taskId);
    if (!current) return null;
    const { meta, body } = parseTaskIssueBody(await this.rawBody(taskId));
    meta.status = status;
    const { state, stateReason } = statusToGithub(status);
    const labels = await this.labelsWithStatus(taskId, state === "open" ? status : null);
    return this.patch(taskId, {
      body: renderTaskIssueBody(meta, body),
      state,
      state_reason: stateReason,
      labels,
    });
  }

  async updateModel(taskId: string, model: string): Promise<TaskFile | null> {
    const { meta, body } = parseTaskIssueBody(await this.rawBody(taskId));
    const trimmed = model.trim();
    if (trimmed) meta.model = trimmed;
    else meta.model = undefined;
    return this.patch(taskId, { body: renderTaskIssueBody(meta, body) });
  }

  async updateBody(taskId: string, body: string): Promise<TaskFile | null> {
    const { meta } = parseTaskIssueBody(await this.rawBody(taskId));
    return this.patch(taskId, { body: renderTaskIssueBody(meta, body) });
  }

  /** Fetch the raw issue body (frontmatter included) for an edit round-trip. */
  private async rawBody(taskId: string): Promise<string> {
    const headers = await this.headers();
    const res = await this.fetchFn(`${this.base()}/issues/${taskId}`, { headers });
    if (!res.ok) await this.fail(res, `read issue #${taskId}`);
    const issue = (await res.json()) as IssueApi;
    return issue.body ?? "";
  }

  /** Preserve `factory` + non-status labels; set the single `status:*` label. */
  private async labelsWithStatus(
    taskId: string,
    status: TaskFrontmatter["status"] | null,
  ): Promise<string[]> {
    const headers = await this.headers();
    const res = await this.fetchFn(`${this.base()}/issues/${taskId}`, { headers });
    if (!res.ok) await this.fail(res, `read issue #${taskId}`);
    const issue = (await res.json()) as IssueApi;
    const kept = labelNames(issue.labels).filter((n) => !n.startsWith("status:"));
    if (!kept.includes(FACTORY_LABEL)) kept.push(FACTORY_LABEL);
    if (status) kept.push(`status:${status}`);
    return kept;
  }

  private async patch(taskId: string, payload: Record<string, unknown>): Promise<TaskFile> {
    const headers = await this.headers();
    const res = await this.fetchFn(`${this.base()}/issues/${taskId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) await this.fail(res, `update issue #${taskId}`);
    const issue = (await res.json()) as IssueApi;
    return issueToTaskFile(this.owner, this.repo, issue);
  }
}
