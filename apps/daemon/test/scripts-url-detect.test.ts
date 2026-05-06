import { describe, expect, test } from "bun:test";
import { UrlScanner } from "../src/scripts/url-detect.ts";

describe("UrlScanner", () => {
  test("extracts http(s) URLs from a chunk", () => {
    const s = new UrlScanner();
    const fresh = s.feed("server up at https://example.com:8080/path and http://api.test\n");
    expect(fresh).toContain("https://example.com:8080/path");
    expect(fresh).toContain("http://api.test");
  });

  test("dedupes URLs across chunks", () => {
    const s = new UrlScanner();
    s.feed("hit http://localhost:3000\n");
    const second = s.feed("again http://localhost:3000 and again\n");
    expect(second).not.toContain("http://localhost:3000");
    expect(s.list()).toEqual(["http://localhost:3000"]);
  });

  test("infers http:// for bare localhost references", () => {
    const s = new UrlScanner();
    const fresh = s.feed("listening on localhost:5173\n");
    expect(fresh).toContain("http://localhost:5173");
  });

  test("trims trailing punctuation from detected URLs", () => {
    const s = new UrlScanner();
    const fresh = s.feed("see http://example.com/foo, then https://api.test/bar.\n");
    expect(fresh).toContain("http://example.com/foo");
    expect(fresh).toContain("https://api.test/bar");
  });

  test("handles 127.0.0.1 with port", () => {
    const s = new UrlScanner();
    const fresh = s.feed("Local:    http://127.0.0.1:4321/\n");
    // The full URL takes precedence; the bare 127.0.0.1 form would dedupe.
    expect(fresh.some((u) => u.startsWith("http://127.0.0.1:4321"))).toBe(true);
  });
});
