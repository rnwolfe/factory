import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface FactoryConfig {
  /** HTTP listen port. */
  port: number;
  /** Bind host. Default 0.0.0.0 so the PWA on a phone can reach it. */
  host: string;
  /** Bearer token required on every tRPC + WS request. */
  auth: { token: string };
  /** Absolute path to the workdir root. Projects live under `<workdir>/projects/`. */
  workdir: string;
  /** Where run worktrees are created. Defaults to `<workdir>/worktrees/`. */
  worktreesRoot: string;
  /** Path to the SQLite database. */
  dbPath: string;
  /** Maximum concurrent runs in the worker pool. */
  maxConcurrentRuns: number;
  /** Default budget seconds for runs that don't specify one. */
  defaultRunBudgetSeconds: number;
  /**
   * Wall-clock cap (seconds) for non-run agent invocations: triage, plan
   * iteration, audit iteration, feedback. 0 = unlimited (matches running
   * `claude` directly). Quality is more important than speed by default.
   */
  agentBudgetSeconds: number;
  /** Git author identity for project bootstrap commits. */
  gitAuthor: { name: string; email: string };
  /**
   * v0.4 cut 4 — GitHub Personal Access Token used by `projects.publishToGithub`.
   * Loaded from `auth.githubToken` in config.yaml; null when unset. Required
   * `repo` scope for private repos, `public_repo` is enough for public.
   */
  githubToken: string | null;
  /**
   * GitHub App ("Factory") credentials for the bot identity used by machine
   * actions — commits/pushes today (ADR-007 Phase 1), issues/comments in later
   * phases. Loaded from `auth.githubApp` in config.yaml or the `github-app-*`
   * settings. Null when unconfigured: runs fall back to the string `gitAuthor`
   * and no issue/webhook features are available. See
   * docs/adr/007-github-issue-backend.md.
   */
  githubApp: {
    appId: string;
    slug: string;
    /** PEM private key. */
    privateKey: string;
    /** HMAC secret for webhook verification (Phase 3). Null until set. */
    webhookSecret: string | null;
  } | null;
  /**
   * v0.4 cut 6 — id of the project that holds Factory's own meta-work. When
   * set, "promote to plan / promote to task" on a feedback row creates a
   * feature_plan / task on this project. Set the operator-edits-config-yaml
   * way for now (no PWA path yet).
   */
  factoryProjectId: string | null;
  /**
   * When true, a successful agent_exit fires a push notification (in addition
   * to existing pushes for blocked / failed / merge_failure outcomes). Off by
   * default — auto-advance + 4-worker concurrency would otherwise spam the
   * dock with one push per completed run.
   */
  notifyOnRunComplete: boolean;
  /**
   * VAPID keypair for Web Push. The PWA uses `publicKey` to register a
   * subscription with the browser's push service; the daemon signs delivery
   * requests with `privateKey`. `subject` is a `mailto:` or `https:` URI
   * the push service can contact about abuse — required by RFC 8292.
   *
   * Generated on first daemon start (see `ensureVapid`) and persisted to
   * config.yaml so subscriptions survive restarts.
   */
  vapid: { publicKey: string; privateKey: string; subject: string };
}

export interface ConfigSource {
  configPath: string;
  loadedFromDisk: boolean;
}

const DEFAULT_HOME = path.join(os.homedir(), "factory");

function defaultConfigPath(): string {
  const home = process.env.FACTORY_HOME;
  if (home) return path.join(home, "config.yaml");
  return path.join(os.homedir(), ".factory", "config.yaml");
}
const DEFAULT_CONFIG_PATH = defaultConfigPath();

function generateToken(): string {
  // 32 bytes → 43 char base64url. Plenty.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

interface PartialConfig {
  port?: number;
  host?: string;
  auth?: {
    token?: string;
    githubToken?: string | null;
    githubApp?: {
      appId?: string | number;
      slug?: string;
      privateKey?: string;
      webhookSecret?: string | null;
    } | null;
  };
  workdir?: string;
  worktreesRoot?: string;
  dbPath?: string;
  maxConcurrentRuns?: number;
  defaultRunBudgetSeconds?: number;
  agentBudgetSeconds?: number;
  gitAuthor?: { name?: string; email?: string };
  factoryProjectId?: string | null;
  vapid?: { publicKey?: string; privateKey?: string; subject?: string };
}

function fillDefaults(p: PartialConfig): FactoryConfig {
  const workdir = p.workdir ?? process.env.FACTORY_HOME ?? DEFAULT_HOME;
  return {
    port: p.port ?? Number(process.env.FACTORY_PORT ?? 4080),
    host: p.host ?? process.env.FACTORY_HOST ?? "0.0.0.0",
    auth: { token: p.auth?.token ?? process.env.FACTORY_TOKEN ?? generateToken() },
    workdir,
    worktreesRoot:
      p.worktreesRoot ?? process.env.FACTORY_WORKTREES ?? path.join(workdir, "worktrees"),
    dbPath: p.dbPath ?? process.env.FACTORY_DB ?? path.join(workdir, "data.db"),
    maxConcurrentRuns: p.maxConcurrentRuns ?? Number(process.env.FACTORY_MAX_RUNS ?? 4),
    defaultRunBudgetSeconds:
      p.defaultRunBudgetSeconds ?? Number(process.env.FACTORY_RUN_BUDGET ?? 7200),
    agentBudgetSeconds: p.agentBudgetSeconds ?? Number(process.env.FACTORY_AGENT_BUDGET ?? 0),
    gitAuthor: {
      name: p.gitAuthor?.name ?? process.env.FACTORY_GIT_NAME ?? "Factory",
      email: p.gitAuthor?.email ?? process.env.FACTORY_GIT_EMAIL ?? "factory@localhost",
    },
    githubToken: p.auth?.githubToken ?? process.env.FACTORY_GITHUB_TOKEN ?? null,
    githubApp: ((): FactoryConfig["githubApp"] => {
      const a = p.auth?.githubApp;
      // All three core fields must be present for the App to be usable. The
      // webhook secret is optional until Phase 3. Settings-DB overrides (the
      // `github-app-*` keys) are layered on top of this default at boot.
      if (a?.appId && a.slug && a.privateKey) {
        return {
          appId: String(a.appId),
          slug: a.slug,
          privateKey: a.privateKey,
          webhookSecret: a.webhookSecret ?? null,
        };
      }
      return null;
    })(),
    factoryProjectId: p.factoryProjectId ?? process.env.FACTORY_META_PROJECT_ID ?? null,
    notifyOnRunComplete: false,
    // VAPID is filled in by `ensureVapid` after first load — the keypair is
    // material that needs to be generated, not synthesized from env defaults.
    // Until then the fields are empty strings; the notifications router
    // refuses operations when publicKey is empty.
    //
    // The default subject uses example.com (RFC 2606 reserved) rather than
    // localhost because APNs (Apple's push service) validates the JWT `sub`
    // claim and rejects subjects with non-routable TLDs — `factory@localhost`
    // returns 403 BadJwtToken on every iOS push attempt. example.com is a
    // real DNS-resolvable IANA-reserved domain that all push services
    // (APNs, FCM, Mozilla) accept. Operators with their own domain can
    // override via `vapid.subject` in config.yaml.
    vapid: {
      publicKey: p.vapid?.publicKey ?? "",
      privateKey: p.vapid?.privateKey ?? "",
      subject: p.vapid?.subject ?? "mailto:noreply@example.com",
    },
  };
}

export async function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<{
  config: FactoryConfig;
  source: ConfigSource;
}> {
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf8");
    const parsed = (YAML.parse(raw) ?? {}) as PartialConfig;
    return {
      config: fillDefaults(parsed),
      source: { configPath, loadedFromDisk: true },
    };
  }
  return {
    config: fillDefaults({}),
    source: { configPath, loadedFromDisk: false },
  };
}

/**
 * Write a FactoryConfig to disk in YAML form. Used by the daemon's
 * first-start path to persist a synthesized config (token + defaults)
 * so subsequent restarts use the same auth token instead of minting a
 * fresh ephemeral one each time.
 *
 * If `existing` is omitted, generates a fresh defaults config. Pass
 * the in-memory config from `loadConfig()` to preserve its token.
 */
export async function writeInitialConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
  existing?: FactoryConfig,
): Promise<{
  config: FactoryConfig;
  configPath: string;
}> {
  const config = existing ?? fillDefaults({});
  await mkdir(path.dirname(configPath), { recursive: true });
  const yamlText = YAML.stringify(serializeConfig(config));
  await writeFile(configPath, yamlText, { mode: 0o600 });
  return { config, configPath };
}

function serializeConfig(config: FactoryConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    port: config.port,
    host: config.host,
    auth: { token: config.auth.token },
    workdir: config.workdir,
    worktreesRoot: config.worktreesRoot,
    dbPath: config.dbPath,
    maxConcurrentRuns: config.maxConcurrentRuns,
    defaultRunBudgetSeconds: config.defaultRunBudgetSeconds,
    gitAuthor: config.gitAuthor,
  };
  if (config.vapid.publicKey && config.vapid.privateKey) {
    out.vapid = {
      publicKey: config.vapid.publicKey,
      privateKey: config.vapid.privateKey,
      subject: config.vapid.subject,
    };
  }
  return out;
}

/**
 * Ensure a VAPID keypair exists on `config`. If both keys are already set
 * (loaded from disk), returns false — nothing to do. Otherwise generates a
 * fresh keypair via `web-push`, mutates `config.vapid` in place, and
 * persists the updated config to `configPath`. Returns true to indicate the
 * caller should log this as a one-time event.
 */
export async function ensureVapid(config: FactoryConfig, configPath: string): Promise<boolean> {
  if (config.vapid.publicKey && config.vapid.privateKey) return false;
  const { default: webpush } = await import("web-push");
  const keys = webpush.generateVAPIDKeys();
  config.vapid = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    // See fillDefaults — `mailto:factory@localhost` is rejected by APNs.
    subject: config.vapid.subject || "mailto:noreply@example.com",
  };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(serializeConfig(config)), { mode: 0o600 });
  return true;
}

export const DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_PATH;
