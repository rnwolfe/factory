import { type Db, schema } from "@factory/db";
import { eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";

/**
 * Operator-tunable runtime settings live in the DB so the PWA can edit them
 * without an SSH session. `~/.factory/config.yaml` continues to provide
 * boot-time defaults (and the bearer token + paths, which can never move
 * to DB without a chicken-and-egg problem). When a setting is present in
 * the DB it overrides the yaml value at boot.
 *
 * Keys are kebab-case. Each is parsed/serialized by this module — callers
 * read FactoryConfig as before.
 *
 * Yaml-derived defaults are snapshotted on first apply so `clear` can
 * restore them. Without that, "clear" would leave the operator-set value
 * in memory until the next daemon restart.
 */

export const SETTING_KEYS = [
  "git-author-name",
  "git-author-email",
  "max-concurrent-runs",
  "default-run-budget-seconds",
  "agent-budget-seconds",
  "github-token",
  // GitHub App ("Factory") credentials — the bot identity for machine actions
  // (ADR-007). Assembled into FactoryConfig.githubApp; the private key and
  // webhook secret are never returned raw (snapshotSettings exposes presence
  // only). DB rows override the `auth.githubApp` yaml block.
  "github-app-id",
  "github-app-slug",
  "github-app-private-key",
  "github-app-webhook-secret",
  // Comma/whitespace-separated GitHub logins whose issue comments the App will
  // answer (Phase 3 conversational replies). Parsed into
  // FactoryConfig.githubReplyAllowlist (lowercased, deduped). Empty = rely on
  // repo write-access alone. DB-only; no yaml backstop.
  "github-app-reply-allowlist",
  // Public base URL the PWA is reachable at (no trailing slash). Used to build
  // absolute deep links back into Factory from the GitHub App's issue replies.
  // Empty = links omitted. DB-only; no yaml backstop.
  "public-base-url",
  "factory-project-id",
  "notify-on-run-complete",
  // Feature flag (default off): when auto-advance drains a project's ready
  // queue, emit a `queue_empty` inbox nudge so the project doesn't stall
  // silently. "true" | "false". Behavior-side; read directly from the DB in
  // inbox/queue-empty.ts, not wired through FactoryConfig.
  "notify-on-queue-empty",
  // Ops dashboard + model defaults — display-side, not wired through FactoryConfig.
  "landing-route", // "inbox" | "ops"
  // System-level default Claude model id (e.g. "claude-sonnet-4-6"). Empty/null
  // falls through to the CLI's own default. Sits at the bottom of the
  // inheritance chain: task model → project model → this → CLI default.
  "default-model",
  // System-level default headless agent. Currently "claude-code" or "codex".
  // Sits at the bottom of the agent inheritance chain:
  //   submit input → task.frontmatter.agent → this → "claude-code".
  // task-020 will add a per-project agent picker; until then this is how
  // operators select codex as the default for new runs without per-task overrides.
  "default-agent",
  // Feature flag: surface the experimental Fable 5 model in the claude-code
  // model picker. "true" | "false" (default false). Display/registry-side only —
  // `agents.list` reads it to conditionally append the model; nothing in
  // FactoryConfig depends on it.
  "experimental-fable-5",
  // The Watch (ADR-010): how often the out-of-band-work synthesis job runs.
  // "off" | "hourly" | "daily" | "weekly" (default daily). Read live each tick
  // by the scheduler — operator-tunable without a restart. Token-intensive once
  // slice 3 wires synthesis, so it is a first-class knob from the start.
  "watch-synthesis-cadence",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(k: string): k is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(k);
}

interface ConfigDefaults {
  gitAuthor: { name: string; email: string };
  maxConcurrentRuns: number;
  defaultRunBudgetSeconds: number;
  agentBudgetSeconds: number;
  githubToken: string | null;
  githubApp: FactoryConfig["githubApp"];
  githubReplyAllowlist: string[];
  publicBaseUrl: string | null;
  factoryProjectId: string | null;
  notifyOnRunComplete: boolean;
}

/** Normalize a public base URL: trim, drop trailing slashes; "" → null. */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a comma/whitespace-separated allowlist string into lowercased, deduped
 * GitHub logins. Tolerates leading `@`, commas, and newlines so the operator
 * can paste from anywhere. Exported for the settings router's validation.
 */
export function parseReplyAllowlist(raw: string): string[] {
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,]+/)) {
    const login = tok.trim().replace(/^@/, "").toLowerCase();
    if (login) seen.add(login);
  }
  return [...seen];
}

const defaultsByConfig = new WeakMap<FactoryConfig, ConfigDefaults>();

/** Snapshot the yaml/env values so a later `clear` can restore them. */
function captureDefaults(config: FactoryConfig): ConfigDefaults {
  const cached = defaultsByConfig.get(config);
  if (cached) return cached;
  const snap: ConfigDefaults = {
    gitAuthor: { ...config.gitAuthor },
    maxConcurrentRuns: config.maxConcurrentRuns,
    defaultRunBudgetSeconds: config.defaultRunBudgetSeconds,
    agentBudgetSeconds: config.agentBudgetSeconds,
    githubToken: config.githubToken,
    githubApp: config.githubApp ? { ...config.githubApp } : null,
    githubReplyAllowlist: [...config.githubReplyAllowlist],
    publicBaseUrl: config.publicBaseUrl,
    factoryProjectId: config.factoryProjectId,
    notifyOnRunComplete: config.notifyOnRunComplete,
  };
  defaultsByConfig.set(config, snap);
  return snap;
}

/** Read all DB-stored settings into a `Map<key, value>`. */
export function readAllSettings(db: Db): Map<SettingKey, string> {
  const rows = db.select().from(schema.settings).all();
  const out = new Map<SettingKey, string>();
  for (const row of rows) {
    if (isSettingKey(row.key)) out.set(row.key, row.value);
  }
  return out;
}

/**
 * Apply DB-stored settings to an in-memory FactoryConfig. Yaml-derived
 * values are kept as defaults (captured on first call); only keys present
 * in the DB override. Mutates in place so all `DaemonContext.config`
 * references see the new values without rewiring.
 */
export function applySettingsFromDb(db: Db, config: FactoryConfig): void {
  const defaults = captureDefaults(config);
  // Reset to yaml/env defaults first; the map below re-applies any DB rows.
  config.gitAuthor = { ...defaults.gitAuthor };
  config.maxConcurrentRuns = defaults.maxConcurrentRuns;
  config.defaultRunBudgetSeconds = defaults.defaultRunBudgetSeconds;
  config.agentBudgetSeconds = defaults.agentBudgetSeconds;
  config.githubToken = defaults.githubToken;
  config.githubApp = defaults.githubApp ? { ...defaults.githubApp } : null;
  config.githubReplyAllowlist = [...defaults.githubReplyAllowlist];
  config.publicBaseUrl = defaults.publicBaseUrl;
  config.factoryProjectId = defaults.factoryProjectId;
  config.notifyOnRunComplete = defaults.notifyOnRunComplete;
  const map = readAllSettings(db);
  applySettingsMap(map, config);
}

/** Internal — apply a key-value map to an in-memory FactoryConfig. */
function applySettingsMap(map: Map<SettingKey, string>, config: FactoryConfig): void {
  const name = map.get("git-author-name");
  if (name !== undefined && name !== "") config.gitAuthor.name = name;
  const email = map.get("git-author-email");
  if (email !== undefined && email !== "") config.gitAuthor.email = email;
  const maxRuns = map.get("max-concurrent-runs");
  if (maxRuns !== undefined) {
    const n = Number.parseInt(maxRuns, 10);
    if (Number.isFinite(n) && n >= 1) config.maxConcurrentRuns = n;
  }
  const budget = map.get("default-run-budget-seconds");
  if (budget !== undefined) {
    const n = Number.parseInt(budget, 10);
    // 0 = infinite (no timeout); otherwise require a sensible floor.
    if (Number.isFinite(n) && (n === 0 || n >= 60)) config.defaultRunBudgetSeconds = n;
  }
  const agentBudget = map.get("agent-budget-seconds");
  if (agentBudget !== undefined) {
    const n = Number.parseInt(agentBudget, 10);
    // 0 = unlimited (default); otherwise require a sensible floor.
    if (Number.isFinite(n) && (n === 0 || n >= 30)) config.agentBudgetSeconds = n;
  }
  const token = map.get("github-token");
  if (token !== undefined) {
    config.githubToken = token === "" ? null : token;
  }
  // GitHub App credentials — assembled from up to four keys; any DB row
  // overrides the yaml value. Clearing the app id (empty string) disables it.
  {
    const idRow = map.get("github-app-id");
    const slugRow = map.get("github-app-slug");
    const keyRow = map.get("github-app-private-key");
    const secretRow = map.get("github-app-webhook-secret");
    if (
      idRow !== undefined ||
      slugRow !== undefined ||
      keyRow !== undefined ||
      secretRow !== undefined
    ) {
      const base = config.githubApp ?? { appId: "", slug: "", privateKey: "", webhookSecret: null };
      const appId = idRow !== undefined ? idRow : base.appId;
      const slug = slugRow !== undefined ? slugRow : base.slug;
      const privateKey = keyRow !== undefined ? keyRow : base.privateKey;
      const webhookSecret =
        secretRow !== undefined ? (secretRow === "" ? null : secretRow) : base.webhookSecret;
      config.githubApp =
        appId && slug && privateKey ? { appId, slug, privateKey, webhookSecret } : null;
    }
  }
  const allowlist = map.get("github-app-reply-allowlist");
  if (allowlist !== undefined) {
    config.githubReplyAllowlist = parseReplyAllowlist(allowlist);
  }
  const baseUrl = map.get("public-base-url");
  if (baseUrl !== undefined) {
    config.publicBaseUrl = normalizeBaseUrl(baseUrl);
  }
  const projectId = map.get("factory-project-id");
  if (projectId !== undefined) {
    config.factoryProjectId = projectId === "" ? null : projectId;
  }
  const notify = map.get("notify-on-run-complete");
  if (notify !== undefined) {
    config.notifyOnRunComplete = notify === "true";
  }
}

/**
 * Write a setting and mutate the live config. `value` of empty string for
 * nullable fields (github-token, factory-project-id) clears the override
 * back to the yaml default.
 */
export function setSetting(db: Db, config: FactoryConfig, key: SettingKey, value: string): void {
  const now = Date.now();
  db.insert(schema.settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: now },
    })
    .run();
  // Re-apply (full re-read) so dependent fields stay consistent.
  applySettingsFromDb(db, config);
}

/** Delete a setting row, then re-apply. The yaml default takes over. */
export function clearSetting(db: Db, config: FactoryConfig, key: SettingKey): void {
  db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
  applySettingsFromDb(db, config);
}

export type LandingRoute = "inbox" | "ops";

export interface OpsSettings {
  landingRoute: LandingRoute;
  /**
   * System-level default Claude model id. Null = use the CLI's own default.
   * Bottom of the inheritance chain: task.model → project.model → this → null.
   */
  defaultModel: string | null;
  /**
   * System-level default headless agent. Null = "claude-code". Bottom of the
   * agent inheritance chain: submit input → task.frontmatter.agent → this →
   * "claude-code".
   */
  defaultAgent: string | null;
  /**
   * Feature flag — when true the claude-code model picker offers the
   * experimental Fable 5 model. Off by default.
   */
  experimentalFable5: boolean;
  /**
   * Feature flag — when true, auto-advance emits a `queue_empty` inbox nudge
   * once a project's ready queue drains. Off by default.
   */
  notifyOnQueueEmpty: boolean;
}

export interface SettingsView {
  gitAuthor: { name: string; email: string };
  maxConcurrentRuns: number;
  defaultRunBudgetSeconds: number;
  agentBudgetSeconds: number;
  githubToken: string | null;
  /**
   * GitHub App presence — secrets (private key, webhook secret) are redacted to
   * booleans here; the raw PEM never leaves the daemon. `appId`/`slug` are not
   * secret and surface so the PWA can show which App is wired.
   */
  githubApp: {
    configured: boolean;
    appId: string | null;
    slug: string | null;
    hasPrivateKey: boolean;
    hasWebhookSecret: boolean;
  };
  /** GitHub logins the App will answer (in addition to repo collaborators). */
  githubReplyAllowlist: string[];
  /** Public base URL for deep links back into Factory (no trailing slash). */
  publicBaseUrl: string | null;
  factoryProjectId: string | null;
  notifyOnRunComplete: boolean;
  /** Ops dashboard settings — live in the DB-settings layer only (no yaml backstop). */
  ops: OpsSettings;
  /** Which keys have a DB row (true) vs. coming from yaml/env defaults (false). */
  overridden: Record<SettingKey, boolean>;
}

/**
 * Read-only snapshot of the current operator settings. The PWA settings
 * page renders this directly. `githubToken` is *not* redacted here — the
 * settings router handles that.
 */
export function snapshotSettings(db: Db, config: FactoryConfig): SettingsView {
  const map = readAllSettings(db);
  const overridden = Object.fromEntries(SETTING_KEYS.map((k) => [k, map.has(k)])) as Record<
    SettingKey,
    boolean
  >;
  return {
    gitAuthor: config.gitAuthor,
    maxConcurrentRuns: config.maxConcurrentRuns,
    defaultRunBudgetSeconds: config.defaultRunBudgetSeconds,
    agentBudgetSeconds: config.agentBudgetSeconds,
    githubToken: config.githubToken,
    githubApp: {
      configured: config.githubApp !== null,
      appId: config.githubApp?.appId ?? null,
      slug: config.githubApp?.slug ?? null,
      hasPrivateKey: Boolean(config.githubApp?.privateKey),
      hasWebhookSecret: Boolean(config.githubApp?.webhookSecret),
    },
    githubReplyAllowlist: config.githubReplyAllowlist,
    publicBaseUrl: config.publicBaseUrl,
    factoryProjectId: config.factoryProjectId,
    notifyOnRunComplete: config.notifyOnRunComplete,
    ops: readOpsSettings(map),
    overridden,
  };
}

/** Parse the ops-dashboard slice of the settings map. */
export function readOpsSettings(map: Map<SettingKey, string>): OpsSettings {
  const landingRaw = map.get("landing-route");
  const landingRoute: LandingRoute = landingRaw === "ops" ? "ops" : "inbox";
  const defaultModelRaw = map.get("default-model");
  const defaultAgentRaw = map.get("default-agent");
  return {
    landingRoute,
    defaultModel: defaultModelRaw && defaultModelRaw.length > 0 ? defaultModelRaw : null,
    defaultAgent: defaultAgentRaw && defaultAgentRaw.length > 0 ? defaultAgentRaw : null,
    experimentalFable5: map.get("experimental-fable-5") === "true",
    notifyOnQueueEmpty: map.get("notify-on-queue-empty") === "true",
  };
}
