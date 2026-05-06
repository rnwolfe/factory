import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML, { type Document } from "yaml";

export type Channel = "stable" | "nightly" | "dev";

export interface UpgradeConfig {
  channel: Channel;
  devBranch: string;
  remote: string;
  /** Absolute path to the checkout `factory upgrade` operates on. */
  checkout: string | null;
}

export interface FactoryCliConfig {
  upgrade: UpgradeConfig;
}

function defaultConfigPath(): string {
  const home = process.env.FACTORY_HOME;
  if (home) return path.join(home, "config.yaml");
  return path.join(os.homedir(), ".factory", "config.yaml");
}
export const DEFAULT_CONFIG_PATH = defaultConfigPath();

export function defaults(): UpgradeConfig {
  return {
    channel: "stable",
    devBranch: "dev",
    remote: "origin",
    checkout: null,
  };
}

function isChannel(v: unknown): v is Channel {
  return v === "stable" || v === "nightly" || v === "dev";
}

interface RawUpgradeBlock {
  channel?: unknown;
  devBranch?: unknown;
  remote?: unknown;
  checkout?: unknown;
}

function parseUpgrade(raw: unknown): UpgradeConfig {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as RawUpgradeBlock;
  return {
    channel: isChannel(r.channel) ? r.channel : d.channel,
    devBranch:
      typeof r.devBranch === "string" && r.devBranch.length > 0 ? r.devBranch : d.devBranch,
    remote: typeof r.remote === "string" && r.remote.length > 0 ? r.remote : d.remote,
    checkout: typeof r.checkout === "string" && r.checkout.length > 0 ? r.checkout : null,
  };
}

export async function readConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<UpgradeConfig> {
  if (!existsSync(configPath)) return defaults();
  const text = await readFile(configPath, "utf8");
  const parsed = YAML.parse(text);
  return parseUpgrade((parsed as Record<string, unknown> | null)?.upgrade ?? null);
}

/**
 * Write or update the `upgrade:` block in config.yaml. Preserves comments
 * and key ordering elsewhere via Document round-trip; creates a new file
 * (mode 0o600) if absent.
 */
export async function writeConfig(
  patch: Partial<UpgradeConfig>,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  let doc: Document;
  if (existsSync(configPath)) {
    const text = await readFile(configPath, "utf8");
    doc = YAML.parseDocument(text);
  } else {
    doc = new YAML.Document({});
  }

  const current = parseUpgrade(doc.toJS()?.upgrade ?? null);
  const next: UpgradeConfig = {
    channel: patch.channel ?? current.channel,
    devBranch: patch.devBranch ?? current.devBranch,
    remote: patch.remote ?? current.remote,
    checkout: patch.checkout ?? current.checkout,
  };

  doc.setIn(["upgrade", "channel"], next.channel);
  doc.setIn(["upgrade", "devBranch"], next.devBranch);
  doc.setIn(["upgrade", "remote"], next.remote);
  if (next.checkout) {
    doc.setIn(["upgrade", "checkout"], next.checkout);
  }

  await writeFile(configPath, doc.toString(), { mode: 0o600 });
}
