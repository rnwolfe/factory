// http(s)://host[:port][/path] — anchored to start of word, stops at whitespace.
const URL_RE = /\bhttps?:\/\/[^\s<>"'\\]+/g;
// `localhost:3000` (no protocol) — common dev-server output. Inferred to http://.
const LOCALHOST_RE = /\b(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?\b/g;

const TAIL_LIMIT_BYTES = 200 * 1024; // 200 KB tail to bound memory + scanner cost.

/**
 * Sliding tail buffer + URL detector. Append-only feed; emits URLs as they
 * appear, deduped per-instance. Cheap enough to run on every chunk.
 */
export class UrlScanner {
  private tail = "";
  private detected = new Set<string>();
  private order: string[] = [];

  /** Returns the URLs that appeared in this chunk (not yet seen). */
  feed(chunk: string): string[] {
    this.tail += chunk;
    if (this.tail.length > TAIL_LIMIT_BYTES) {
      // Keep the last half so we don't slice in the middle of a partial URL.
      this.tail = this.tail.slice(this.tail.length - TAIL_LIMIT_BYTES / 2);
    }
    const fresh: string[] = [];
    URL_RE.lastIndex = 0;
    LOCALHOST_RE.lastIndex = 0;
    for (const m of this.tail.matchAll(URL_RE)) {
      const url = trimTrailingPunct(m[0]);
      if (this.add(url)) fresh.push(url);
    }
    for (const m of this.tail.matchAll(LOCALHOST_RE)) {
      const port = m[1];
      const url = port ? `http://localhost:${port}` : "http://localhost";
      if (this.add(url)) fresh.push(url);
    }
    return fresh;
  }

  list(): string[] {
    return this.order.slice();
  }

  private add(url: string): boolean {
    if (this.detected.has(url)) return false;
    this.detected.add(url);
    this.order.push(url);
    return true;
  }
}

function trimTrailingPunct(s: string): string {
  return s.replace(/[),.;:!?]+$/, "");
}
