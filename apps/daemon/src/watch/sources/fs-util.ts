import { readdir, readFile, stat } from "node:fs/promises";

/** Read-only fs helpers shared by harness sources. All swallow errors and
 * return an empty/null sentinel — a source must never throw mid-scan. */

export async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  return (await safeStat(p)) !== null;
}

export async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export async function safeReadFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}
