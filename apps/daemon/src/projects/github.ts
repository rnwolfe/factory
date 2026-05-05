import { spawn as bunSpawn } from "bun";

export class GithubError extends Error {
  constructor(
    public readonly code:
      | "bad_token"
      | "name_conflict"
      | "rate_limited"
      | "network"
      | "push_failed"
      | "no_token"
      | "bad_owner",
    message: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export interface CreateRepoInput {
  token: string;
  owner: { kind: "user" } | { kind: "org"; org: string };
  name: string;
  visibility: "public" | "private";
  description?: string;
}

export interface CreateRepoResult {
  /** "git@github.com:user/name.git" or HTTPS — we use HTTPS for the stored remote. */
  cloneUrlHttps: string;
  htmlUrl: string;
  fullName: string;
}

interface RepoApiResponse {
  clone_url?: string;
  html_url?: string;
  full_name?: string;
}

/**
 * Inject `fetch` for tests. Production passes `globalThis.fetch`.
 */
type FetchFn = typeof globalThis.fetch;

export async function createRepo(
  input: CreateRepoInput,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<CreateRepoResult> {
  if (!input.token) {
    throw new GithubError("no_token", "no GitHub token configured");
  }
  const url =
    input.owner.kind === "user"
      ? "https://api.github.com/user/repos"
      : `https://api.github.com/orgs/${encodeURIComponent(input.owner.org)}/repos`;
  const body = {
    name: input.name,
    description: input.description ?? undefined,
    private: input.visibility === "private",
    auto_init: false,
  };
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "factory-daemon",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GithubError("network", `network error: ${(err as Error).message}`);
  }
  if (res.status === 401) {
    throw new GithubError("bad_token", "GitHub rejected the token (401)");
  }
  if (res.status === 403) {
    throw new GithubError("rate_limited", "GitHub rate-limited or insufficient scope (403)");
  }
  if (res.status === 422) {
    let detail = "name conflict or validation error";
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) detail = j.message;
    } catch {
      // ignore parse failure
    }
    throw new GithubError("name_conflict", `GitHub 422: ${detail}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) detail = j.message;
    } catch {
      // ignore
    }
    throw new GithubError("network", `GitHub ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as RepoApiResponse;
  if (!json.clone_url || !json.html_url || !json.full_name) {
    throw new GithubError("network", "GitHub response missing clone_url / html_url / full_name");
  }
  return {
    cloneUrlHttps: json.clone_url,
    htmlUrl: json.html_url,
    fullName: json.full_name,
  };
}

/**
 * Add `origin` and push `main` to a freshly-created GitHub repo. The token
 * is inlined in the URL only for the push call (one-shot); the persisted
 * remote URL is the plain HTTPS one so subsequent operator pushes don't
 * accidentally include credentials in `.git/config`.
 */
export async function pushToNewRemote(input: {
  workdirPath: string;
  cloneUrlHttps: string;
  token: string;
}): Promise<void> {
  // origin may already exist if the project was imported. Replace if so.
  await git(["remote", "remove", "origin"], input.workdirPath); // best-effort; ignore failure
  const addRes = await git(["remote", "add", "origin", input.cloneUrlHttps], input.workdirPath);
  if (addRes.exitCode !== 0) {
    throw new GithubError("push_failed", `git remote add failed: ${addRes.stderr}`);
  }

  // Construct the auth URL only for the push, never persist it.
  const authUrl = input.cloneUrlHttps.replace(
    "https://",
    `https://x-access-token:${encodeURIComponent(input.token)}@`,
  );
  const pushRes = await git(["push", "-u", authUrl, "main"], input.workdirPath, {
    GIT_TERMINAL_PROMPT: "0",
  });
  if (pushRes.exitCode !== 0) {
    throw new GithubError(
      "push_failed",
      `git push failed: ${pushRes.stderr || pushRes.stdout || "unknown"}`.slice(0, 400),
    );
  }
  // Reset the local upstream tracking to point at the plain URL so the
  // operator's later `git push` doesn't carry the inlined token.
  await git(["remote", "set-url", "origin", input.cloneUrlHttps], input.workdirPath);
}

async function git(
  args: string[],
  cwd: string,
  envExtra?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = bunSpawn({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(envExtra ?? {}) },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: (err as Error).message };
  }
}
