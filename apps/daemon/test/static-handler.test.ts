import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeStaticHandler } from "../src/static.ts";

function setup() {
  const dist = mkdtempSync(path.join(tmpdir(), "factory-static-"));
  mkdirSync(path.join(dist, "icons"), { recursive: true });
  mkdirSync(path.join(dist, "assets"), { recursive: true });
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(path.join(dist, "icons", "apple-touch-icon.png"), "PNGDATA");
  writeFileSync(path.join(dist, "assets", "index-abc.js"), "console.log(1)");
  const handler = makeStaticHandler(dist);
  const req = (p: string) => handler(new Request(`http://x${p}`));
  return { handler, req, cleanup: () => rmSync(dist, { recursive: true, force: true }) };
}

describe("static handler", () => {
  test("a missing asset 404s (not 500, not index.html)", async () => {
    const h = setup();
    try {
      const res = h.req("/does-not-exist.png");
      expect(res?.status).toBe(404);
      // Must not be the SPA HTML fallback served for a .png.
      expect(await res?.text()).not.toContain("<title>app</title>");
    } finally {
      h.cleanup();
    }
  });

  test("iOS root apple-touch-icon probes alias to the real icon (200)", async () => {
    const h = setup();
    try {
      for (const p of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
        const res = h.req(p);
        expect(res?.status ?? 200).toBe(200);
        expect(res?.headers.get("content-type")).toBe("image/png");
        expect(await res?.text()).toBe("PNGDATA");
      }
    } finally {
      h.cleanup();
    }
  });

  test("an existing hashed asset serves with immutable cache", async () => {
    const h = setup();
    try {
      const res = h.req("/assets/index-abc.js");
      expect(res?.status ?? 200).toBe(200);
      expect(res?.headers.get("cache-control")).toContain("immutable");
    } finally {
      h.cleanup();
    }
  });

  test("a non-asset route SPA-falls back to index.html", async () => {
    const h = setup();
    try {
      const res = h.req("/projects/abc");
      expect(res?.headers.get("content-type")).toContain("text/html");
      expect(await res?.text()).toContain("<title>app</title>");
    } finally {
      h.cleanup();
    }
  });

  test("tRPC / ws / health are not handled (fall through to null)", () => {
    const h = setup();
    try {
      expect(h.req("/trpc/x")).toBeNull();
      expect(h.req("/ws/events")).toBeNull();
      expect(h.req("/health")).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
