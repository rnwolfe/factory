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
  "github-token",
  "factory-project-id",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(k: string): k is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(k);
}

interface ConfigDefaults {
  gitAuthor: { name: string; email: string };
  maxConcurrentRuns: number;
  defaultRunBudgetSeconds: number;
  githubToken: string | null;
  factoryProjectId: string | null;
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
    githubToken: config.githubToken,
    factoryProjectId: config.factoryProjectId,
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
  config.githubToken = defaults.githubToken;
  config.factoryProjectId = defaults.factoryProjectId;
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
    if (Number.isFinite(n) && n >= 60) config.defaultRunBudgetSeconds = n;
  }
  const token = map.get("github-token");
  if (token !== undefined) {
    config.githubToken = token === "" ? null : token;
  }
  const projectId = map.get("factory-project-id");
  if (projectId !== undefined) {
    config.factoryProjectId = projectId === "" ? null : projectId;
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

export interface SettingsView {
  gitAuthor: { name: string; email: string };
  maxConcurrentRuns: number;
  defaultRunBudgetSeconds: number;
  githubToken: string | null;
  factoryProjectId: string | null;
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
    githubToken: config.githubToken,
    factoryProjectId: config.factoryProjectId,
    overridden,
  };
}
