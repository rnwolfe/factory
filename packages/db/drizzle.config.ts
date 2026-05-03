import os from "node:os";
import path from "node:path";
import type { Config } from "drizzle-kit";

const dbPath = process.env.FACTORY_DB ?? path.join(os.homedir(), "factory", "data.db");

export default {
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "sqlite",
  dbCredentials: { url: dbPath },
  verbose: true,
  strict: true,
} satisfies Config;
