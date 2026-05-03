import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDaemon } from "../src/index.ts";

interface Booted {
  port: number;
  token: string;
  stop: () => Promise<void>;
}

const stops: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.allSettled(stops.map((s) => s()));
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function boot(): Promise<Booted> {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-daemon-http-"));
  dirs.push(dir);
  // Tell config loader to invent everything via env.
  process.env.FACTORY_HOME = dir;
  process.env.FACTORY_DB = path.join(dir, "data.db");
  process.env.FACTORY_PORT = "0"; // ephemeral
  process.env.FACTORY_HOST = "127.0.0.1";
  process.env.FACTORY_TOKEN = "smoke-token";
  process.env.FACTORY_MAX_RUNS = "1";
  process.env.HOME = dir; // prevent loadConfig from finding ~/.factory/config.yaml on host
  const handle = await startDaemon();
  stops.push(handle.stop);
  return { port: handle.port, token: handle.config.auth.token, stop: handle.stop };
}

describe("daemon HTTP smoke", () => {
  test("health endpoint responds without auth", async () => {
    process.env.FACTORY_PORT = "4181";
    const b = await boot();
    try {
      const r = await fetch(`http://127.0.0.1:${b.port}/health`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await b.stop();
    }
  }, 15_000);

  test("tRPC health.ping works with bearer token", async () => {
    process.env.FACTORY_PORT = "4182";
    const b = await boot();
    try {
      const r = await fetch(`http://127.0.0.1:${b.port}/trpc/health.ping`, {
        headers: { authorization: `Bearer ${b.token}` },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { result: { data: { ok: boolean } } };
      expect(body.result.data.ok).toBe(true);
    } finally {
      await b.stop();
    }
  }, 15_000);

  test("protected procedure is 401 without token", async () => {
    process.env.FACTORY_PORT = "4183";
    const b = await boot();
    try {
      // Decisions inbox is a protected procedure.
      const r = await fetch(`http://127.0.0.1:${b.port}/trpc/decisions.inbox`);
      expect(r.status).toBe(401);
    } finally {
      await b.stop();
    }
  }, 15_000);
});
