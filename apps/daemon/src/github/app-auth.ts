import { createSign } from "node:crypto";
import type { FactoryConfig } from "../config.ts";
import { GithubError } from "../projects/github.ts";

/**
 * GitHub App ("Factory") authentication — the bot identity behind every
 * machine action (commits/pushes today, issues/comments in later phases).
 * Implements ADR-007 §D2 / spec Phase 1 §1.3.
 *
 * Inert until credentials exist: `githubAppClientFromConfig` returns null and
 * `resolveBotGitAuthor` returns null when the App isn't configured, so callers
 * fall back to the default git author with zero behaviour change.
 */

type FetchFn = typeof globalThis.fetch;

const API = "https://api.github.com";
const UA = "factory-daemon";
const API_VERSION = "2022-11-28";

export interface GithubAppCredentials {
  appId: string;
  slug: string;
  /** PEM private key. */
  privateKey: string;
}

export interface BotIdentity {
  /** Git author/committer name, e.g. `factory[bot]`. */
  name: string;
  /** Noreply email that links local commits to the bot account on GitHub. */
  email: string;
  /** Numeric GitHub user id of the bot account. */
  userId: number;
}

export interface InstallationToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Mint a short-lived App JWT (RS256) for app-level GitHub API calls. `nowSec`
 * is injectable for tests. GitHub rejects `exp` more than 10 minutes out; we
 * use 9 and backdate `iat` 60s to tolerate clock skew.
 */
export function appJwt(
  creds: GithubAppCredentials,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: creds.appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(creds.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function mapError(status: number, body: string): GithubError {
  if (status === 401) {
    return new GithubError("bad_token", `GitHub App auth rejected (401): ${body}`);
  }
  if (status === 403) {
    return new GithubError("rate_limited", `GitHub App forbidden / rate-limited (403): ${body}`);
  }
  return new GithubError("network", `GitHub App API error (${status}): ${body}`);
}

/**
 * App-authenticated GitHub client. Caches installation tokens (~1h TTL) per
 * installation id and the resolved bot identity. Inject `fetchFn` for tests.
 */
export class GithubAppClient {
  private readonly tokens = new Map<number, InstallationToken>();
  private botIdentityCache: BotIdentity | null = null;

  constructor(
    private readonly creds: GithubAppCredentials,
    private readonly fetchFn: FetchFn = globalThis.fetch,
  ) {}

  private appHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${appJwt(this.creds)}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  /** Installation id for a repo, or throw `not_installed` (404). */
  async installationId(owner: string, repo: string): Promise<number> {
    const res = await this.fetchFn(`${API}/repos/${owner}/${repo}/installation`, {
      headers: this.appHeaders(),
    });
    if (res.status === 404) {
      throw new GithubError("not_installed", `Factory App is not installed on ${owner}/${repo}`);
    }
    if (!res.ok) throw mapError(res.status, await res.text());
    const body = (await res.json()) as { id: number };
    return body.id;
  }

  /** Installation access token, cached until ~1m before expiry. */
  async installationToken(installationId: number, nowMs: number = Date.now()): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - nowMs > 60_000) return cached.token;
    const res = await this.fetchFn(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: this.appHeaders(),
    });
    if (!res.ok) throw mapError(res.status, await res.text());
    const body = (await res.json()) as { token: string; expires_at: string };
    const entry: InstallationToken = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    this.tokens.set(installationId, entry);
    return entry.token;
  }

  /**
   * Resolve the bot account's git identity. The bot login is `{slug}[bot]`; its
   * numeric user id forms the noreply email that links local commits to the bot
   * on GitHub — the same mechanism `github-actions[bot]` uses.
   */
  async botIdentity(): Promise<BotIdentity> {
    if (this.botIdentityCache) return this.botIdentityCache;
    const login = `${this.creds.slug}[bot]`;
    const res = await this.fetchFn(`${API}/users/${encodeURIComponent(login)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
    if (!res.ok) throw mapError(res.status, await res.text());
    const body = (await res.json()) as { id: number };
    this.botIdentityCache = {
      name: login,
      email: `${body.id}+${login}@users.noreply.github.com`,
      userId: body.id,
    };
    return this.botIdentityCache;
  }
}

/** Construct a client from config, or null when the App isn't configured. */
export function githubAppClientFromConfig(
  config: Pick<FactoryConfig, "githubApp">,
  fetchFn: FetchFn = globalThis.fetch,
): GithubAppClient | null {
  if (!config.githubApp) return null;
  return new GithubAppClient(
    {
      appId: config.githubApp.appId,
      slug: config.githubApp.slug,
      privateKey: config.githubApp.privateKey,
    },
    fetchFn,
  );
}

/** Parse a github remote (https or ssh) into `{ owner, repo }`, or null. */
export function parseGithubRepo(remote: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Resolve the bot git identity for a repo when the Factory App is configured
 * AND installed on it; otherwise null. Defensive — any failure (App absent,
 * remote unparseable, not installed, network) returns null so callers fall back
 * to the default author and a GitHub hiccup never blocks a run.
 */
export async function resolveBotGitAuthor(
  config: Pick<FactoryConfig, "githubApp">,
  remote: string | null,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<BotIdentity | null> {
  const client = githubAppClientFromConfig(config, fetchFn);
  if (!client || !remote) return null;
  const slug = parseGithubRepo(remote);
  if (!slug) return null;
  try {
    await client.installationId(slug.owner, slug.repo); // verify the App can act on this repo
    return await client.botIdentity();
  } catch {
    return null;
  }
}
