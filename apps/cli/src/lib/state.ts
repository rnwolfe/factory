import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Persistent state for the CLI: last-good upgrade sha, upgrade log.
 * Lives in $FACTORY_HOME/state/. Honors FACTORY_HOME env override so tests
 * can point at a temp dir.
 */
function stateDir(): string {
  const home = process.env.FACTORY_HOME || path.join(os.homedir(), ".factory");
  return path.join(home, "state");
}

export function lastGoodPath(): string {
  return path.join(stateDir(), "last-good.sha");
}

export function upgradeLogPath(): string {
  return path.join(stateDir(), "upgrade-log.jsonl");
}

export async function readLastGood(): Promise<string | null> {
  const p = lastGoodPath();
  if (!existsSync(p)) return null;
  const text = (await readFile(p, "utf8")).trim();
  return text.length > 0 ? text : null;
}

export async function writeLastGood(sha: string): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(lastGoodPath(), `${sha}\n`, "utf8");
}

export interface UpgradeLogEntry {
  ts: number;
  from: string | null;
  to: string;
  channel: "stable" | "nightly" | "dev";
  ok: boolean;
  error?: string;
}

export async function appendUpgradeLog(entry: UpgradeLogEntry): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await appendFile(upgradeLogPath(), `${JSON.stringify(entry)}\n`, "utf8");
}
