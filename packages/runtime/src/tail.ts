import { open } from "node:fs/promises";

export interface TailHandle {
  /** Resolves once tailing has stopped naturally or via abort. */
  stop(): Promise<void>;
  /** Force one final read pass to flush remaining bytes. */
  drain(): Promise<void>;
}

/**
 * Follow a growing file, calling `onLine` once per newline-terminated line.
 * Stops when `abort` fires. Lines without a trailing newline are buffered
 * until the next chunk completes them or until `drain()` is called.
 */
export function followFileLines(
  filePath: string,
  onLine: (line: string) => void,
  abort: AbortSignal,
  opts: { pollMs?: number } = {},
): TailHandle {
  const pollMs = opts.pollMs ?? 80;
  let stopped = false;
  let buf = "";
  let offset = 0;
  let runner: Promise<void> | null = null;

  async function readOnce() {
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(filePath, "r");
    } catch {
      return;
    }
    try {
      const stat = await fh.stat();
      const size = stat.size;
      if (size > offset) {
        const chunkSize = size - offset;
        const buffer = Buffer.alloc(chunkSize);
        const { bytesRead } = await fh.read(buffer, 0, chunkSize, offset);
        offset += bytesRead;
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        buf += text;
        let newlineIdx = buf.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buf.slice(0, newlineIdx);
          buf = buf.slice(newlineIdx + 1);
          onLine(line);
          newlineIdx = buf.indexOf("\n");
        }
      } else if (size < offset) {
        // File was truncated; reset.
        offset = 0;
        buf = "";
      }
    } finally {
      await fh.close();
    }
  }

  async function loop() {
    while (!stopped && !abort.aborted) {
      try {
        await readOnce();
      } catch {
        // Swallow transient errors; poll again.
      }
      await Bun.sleep(pollMs);
    }
    // Final flush
    try {
      await readOnce();
    } catch {
      // ignore
    }
    if (buf.length > 0) {
      onLine(buf);
      buf = "";
    }
  }

  runner = loop();

  return {
    async stop() {
      stopped = true;
      if (runner) await runner;
    },
    async drain() {
      try {
        await readOnce();
      } catch {
        // ignore
      }
      if (buf.endsWith("\n")) {
        // already split by readOnce
      } else if (buf.length > 0) {
        // Don't auto-emit partial lines on drain; callers can choose to.
      }
    },
  };
}
