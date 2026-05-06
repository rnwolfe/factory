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
   * v0.4 cut 6 — id of the project that holds Factory's own meta-work. When
   * set, "promote to plan / promote to task" on a feedback row creates a
   * feature_plan / task on this project. Set the operator-edits-config-yaml
   * way for now (no PWA path yet).
   */
  factoryProjectId: string | null;
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
  auth?: { token?: string; githubToken?: string | null };
  workdir?: string;
  worktreesRoot?: string;
  dbPath?: string;
  maxConcurrentRuns?: number;
  defaultRunBudgetSeconds?: number;
  agentBudgetSeconds?: number;
  gitAuthor?: { name?: string; email?: string };
  factoryProjectId?: string | null;
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
    factoryProjectId: p.factoryProjectId ?? process.env.FACTORY_META_PROJECT_ID ?? null,
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

export async function writeInitialConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<{
  config: FactoryConfig;
  configPath: string;
}> {
  const config = fillDefaults({});
  await mkdir(path.dirname(configPath), { recursive: true });
  const yamlText = YAML.stringify({
    port: config.port,
    host: config.host,
    auth: { token: config.auth.token },
    workdir: config.workdir,
    worktreesRoot: config.worktreesRoot,
    dbPath: config.dbPath,
    maxConcurrentRuns: config.maxConcurrentRuns,
    defaultRunBudgetSeconds: config.defaultRunBudgetSeconds,
    gitAuthor: config.gitAuthor,
  });
  await writeFile(configPath, yamlText, { mode: 0o600 });
  return { config, configPath };
}

export const DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_PATH;
