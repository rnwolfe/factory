import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PackageScript {
  scriptName: string;
  command: string;
}

/** Read package.json `scripts` map. Returns [] if no package.json. */
export async function readPackageScripts(workdirPath: string): Promise<PackageScript[]> {
  const pkgPath = path.join(workdirPath, "package.json");
  if (!existsSync(pkgPath)) return [];
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const out: PackageScript[] = [];
  for (const [scriptName, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command === "string" && command.length > 0) {
      out.push({ scriptName, command });
    }
  }
  return out;
}
