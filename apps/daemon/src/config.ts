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
  /** Path to the SQLite database. */
  dbPath: string;
  /** Maximum concurrent runs in the worker pool. */
  maxConcurrentRuns: number;
  /** Default budget seconds for runs that don't specify one. */
  defaultRunBudgetSeconds: number;
  /** Git author identity for project bootstrap commits. */
  gitAuthor: { name: string; email: string };
}

export interface ConfigSource {
  configPath: string;
  loadedFromDisk: boolean;
}

const DEFAULT_HOME = path.join(os.homedir(), "factory");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".factory", "config.yaml");

function generateToken(): string {
  // 32 bytes → 43 char base64url. Plenty.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

interface PartialConfig {
  port?: number;
  host?: string;
  auth?: { token?: string };
  workdir?: string;
  dbPath?: string;
  maxConcurrentRuns?: number;
  defaultRunBudgetSeconds?: number;
  gitAuthor?: { name?: string; email?: string };
}

function fillDefaults(p: PartialConfig): FactoryConfig {
  const workdir = p.workdir ?? process.env.FACTORY_HOME ?? DEFAULT_HOME;
  return {
    port: p.port ?? Number(process.env.FACTORY_PORT ?? 4080),
    host: p.host ?? process.env.FACTORY_HOST ?? "0.0.0.0",
    auth: { token: p.auth?.token ?? process.env.FACTORY_TOKEN ?? generateToken() },
    workdir,
    dbPath: p.dbPath ?? process.env.FACTORY_DB ?? path.join(workdir, "data.db"),
    maxConcurrentRuns: p.maxConcurrentRuns ?? Number(process.env.FACTORY_MAX_RUNS ?? 4),
    defaultRunBudgetSeconds:
      p.defaultRunBudgetSeconds ?? Number(process.env.FACTORY_RUN_BUDGET ?? 7200),
    gitAuthor: {
      name: p.gitAuthor?.name ?? process.env.FACTORY_GIT_NAME ?? "Factory",
      email: p.gitAuthor?.email ?? process.env.FACTORY_GIT_EMAIL ?? "factory@localhost",
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
    dbPath: config.dbPath,
    maxConcurrentRuns: config.maxConcurrentRuns,
    defaultRunBudgetSeconds: config.defaultRunBudgetSeconds,
    gitAuthor: config.gitAuthor,
  });
  await writeFile(configPath, yamlText, { mode: 0o600 });
  return { config, configPath };
}

export const DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_PATH;
