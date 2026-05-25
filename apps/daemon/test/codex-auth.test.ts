import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { probeCodexAuth } from "../src/agents/codex-auth.ts";

describe("probeCodexAuth", () => {
  let prevHome: string | undefined;
  let dir: string;

  beforeEach(() => {
    prevHome = process.env.CODEX_HOME;
    dir = mkdtempSync(path.join(tmpdir(), "factory-codex-auth-"));
    process.env.CODEX_HOME = dir;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports ok when auth.json is present and non-empty", () => {
    writeFileSync(path.join(dir, "auth.json"), '{"OPENAI_API_KEY":"sk-fake"}');
    const status = probeCodexAuth();
    expect(status.ok).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.authPath).toBe(path.join(dir, "auth.json"));
  });

  test("reports missing when auth.json does not exist", () => {
    const status = probeCodexAuth();
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("missing");
    expect(status.reason).toContain("codex login");
  });

  test("reports empty when auth.json exists but has zero bytes", () => {
    writeFileSync(path.join(dir, "auth.json"), "");
    const status = probeCodexAuth();
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("empty");
  });

  test("honors CODEX_HOME override", () => {
    const alt = mkdtempSync(path.join(tmpdir(), "factory-codex-alt-"));
    try {
      mkdirSync(alt, { recursive: true });
      writeFileSync(path.join(alt, "auth.json"), '{"OPENAI_API_KEY":"sk-fake"}');
      process.env.CODEX_HOME = alt;
      const status = probeCodexAuth();
      expect(status.ok).toBe(true);
      expect(status.authPath).toBe(path.join(alt, "auth.json"));
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });
});
