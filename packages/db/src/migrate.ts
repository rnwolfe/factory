import path from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDb, getDefaultDbPath } from "./client.ts";

export function runMigrations(dbPath?: string): void {
  const db = createDb(dbPath);
  const folder = path.join(import.meta.dir, "migrations");
  migrate(db, { migrationsFolder: folder });
}

if (import.meta.main) {
  const target = process.env.FACTORY_DB ?? getDefaultDbPath();
  runMigrations(target);
  console.log(`migrations applied → ${target}`);
}
