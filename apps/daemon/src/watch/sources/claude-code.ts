import os from "node:os";
import path from "node:path";
import { pathExists, safeReaddir, safeReadFile, safeStat } from "./fs-util.ts";
import {
  type HarnessSource,
  isSecretFile,
  type MemoryDoc,
  type WatchCursor,
  type WorkRecord,
} from "./types.ts";

const SOURCE_ID = "claude-code";

/**
 * Claude Code source: reads `<root>/projects/<slug>/*.jsonl` session
 * transcripts and `<root>/projects/<slug>/memory/*.md` curated memory.
 * `root` defaults to `~/.claude`; injectable for tests.
 */
export function createClaudeCodeSource(opts: { root?: string } = {}): HarnessSource {
  const root = opts.root ?? path.join(os.homedir(), ".claude");
  const projectsDir = path.join(root, "projects");

  return {
    id: SOURCE_ID,
    label: "Claude Code",

    async isAvailable() {
      return pathExists(projectsDir);
    },

    async scan(cursor: WatchCursor | null) {
      const sinceMs = cursorMs(cursor);
      const records: WorkRecord[] = [];
      for (const dir of await safeReaddir(projectsDir)) {
        const projectDir = path.join(projectsDir, dir);
        for (const f of await safeReaddir(projectDir)) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(projectDir, f);
          // Cheap mtime prefilter before reading the whole transcript.
          const s = await safeStat(file);
          if (!s || s.mtimeMs <= sinceMs) continue;
          const rec = await parseSession(file);
          if (rec && (rec.endedAt ?? rec.startedAt) > sinceMs) records.push(rec);
        }
      }
      records.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
      const newest = records.reduce((m, r) => Math.max(m, r.endedAt ?? r.startedAt), sinceMs);
      return { records, next: { sourceId: SOURCE_ID, position: new Date(newest).toISOString() } };
    },

    async readMemories() {
      const docs: MemoryDoc[] = [];
      for (const dir of await safeReaddir(projectsDir)) {
        const memDir = path.join(projectsDir, dir, "memory");
        for (const f of await safeReaddir(memDir)) {
          if (!f.endsWith(".md") || isSecretFile(f)) continue;
          const p = path.join(memDir, f);
          const body = await safeReadFile(p);
          if (body !== null)
            docs.push({ sourceId: SOURCE_ID, path: p, title: `${dir}/${f}`, body });
        }
      }
      return docs;
    },
  };
}

interface ClaudeEvent {
  type?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
}

async function parseSession(file: string): Promise<WorkRecord | null> {
  const raw = await safeReadFile(file);
  if (raw === null) return null;

  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let sessionId = path.basename(file, ".jsonl");
  let firstUserText: string | null = null;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = 0;
  let userCount = 0;
  let assistantCount = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: ClaudeEvent;
    try {
      ev = JSON.parse(line) as ClaudeEvent;
    } catch {
      continue; // tolerate partial / non-JSON lines
    }
    if (ev.cwd && !cwd) cwd = ev.cwd;
    if (ev.gitBranch && !gitBranch) gitBranch = ev.gitBranch;
    if (ev.sessionId) sessionId = ev.sessionId;
    const t = ev.timestamp ? Date.parse(ev.timestamp) : Number.NaN;
    if (Number.isFinite(t)) {
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }
    if (ev.type === "user") {
      userCount++;
      if (!firstUserText) {
        const txt = textContent(ev.message?.content);
        // Skip system-reminder / tool-result wrappers; we want the real prompt.
        if (txt && !txt.startsWith("<")) firstUserText = txt.trim();
      }
    } else if (ev.type === "assistant") {
      assistantCount++;
    }
  }

  if (!Number.isFinite(minTs)) return null; // no parseable timestamped events
  return {
    sourceId: SOURCE_ID,
    sessionId,
    projectPath: cwd,
    gitBranch,
    startedAt: minTs,
    endedAt: maxTs || null,
    title: (firstUserText ?? "(no prompt)").slice(0, 140),
    summary: `${userCount} user / ${assistantCount} assistant messages${gitBranch ? ` on ${gitBranch}` : ""}`,
    signals: [],
  };
}

/** Claude user content is a string; assistant content is an array of blocks. */
function textContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  return null;
}

function cursorMs(cursor: WatchCursor | null): number {
  if (!cursor) return 0;
  const t = Date.parse(cursor.position);
  return Number.isFinite(t) ? t : 0;
}

export const claudeCodeSource = createClaudeCodeSource();
