import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

export function getDefaultDbPath(): string {
  if (process.env.FACTORY_DB) return process.env.FACTORY_DB;
  if (process.env.FACTORY_HOME) return path.join(process.env.FACTORY_HOME, "data.db");
  return path.join(os.homedir(), "factory", "data.db");
}

export function openSqlite(dbPath: string = getDefaultDbPath()): Database {
  // Bun's Database({ create: true }) auto-creates the file but not parent dirs.
  const dir = path.dirname(dbPath);
  if (dir) {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return sqlite;
}

export function createDb(dbPath?: string) {
  const sqlite = openSqlite(dbPath);
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
