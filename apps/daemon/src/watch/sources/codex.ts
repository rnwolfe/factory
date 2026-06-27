import os from "node:os";
import path from "node:path";
import { pathExists, safeReaddir, safeReadFile } from "./fs-util.ts";
import {
  type HarnessSource,
  isSecretFile,
  type MemoryDoc,
  type WatchCursor,
  type WorkRecord,
} from "./types.ts";

const SOURCE_ID = "codex";

/**
 * Codex source: reads `<root>/history.jsonl` (`{session_id, text, ts}` lines),
 * grouping by session into one {@link WorkRecord} per session, and
 * `<root>/memories/*.md` curated memory. `root` defaults to `~/.codex`;
 * injectable for tests.
 *
 * Note: the richer `<root>/sessions/<y>/<m>/<d>/rollout-*.jsonl` rollouts carry
 * cwd/tool detail and are a future enrichment — history.jsonl is the reliable
 * first cut. Until then `projectPath` is null for Codex records.
 */
export function createCodexSource(opts: { root?: string } = {}): HarnessSource {
  const root = opts.root ?? path.join(os.homedir(), ".codex");
  const historyFile = path.join(root, "history.jsonl");
  const memoriesDir = path.join(root, "memories");

  return {
    id: SOURCE_ID,
    label: "Codex",

    async isAvailable() {
      return pathExists(historyFile);
    },

    async scan(cursor: WatchCursor | null) {
      const sinceMs = cursorMs(cursor);
      const sessions = await readHistory(historyFile);
      const records: WorkRecord[] = [];
      for (const s of sessions.values()) {
        if (s.endedAt <= sinceMs) continue;
        records.push({
          sourceId: SOURCE_ID,
          sessionId: s.sessionId,
          projectPath: null,
          gitBranch: null,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          title: (s.firstText ?? "(no prompt)").slice(0, 140),
          summary: `${s.count} prompt${s.count === 1 ? "" : "s"}`,
          signals: [],
        });
      }
      records.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
      const newest = records.reduce((m, r) => Math.max(m, r.endedAt ?? r.startedAt), sinceMs);
      return { records, next: { sourceId: SOURCE_ID, position: new Date(newest).toISOString() } };
    },

    async readMemories() {
      const docs: MemoryDoc[] = [];
      for (const f of await safeReaddir(memoriesDir)) {
        if (!f.endsWith(".md") || isSecretFile(f)) continue;
        const p = path.join(memoriesDir, f);
        const body = await safeReadFile(p);
        if (body !== null) docs.push({ sourceId: SOURCE_ID, path: p, title: f, body });
      }
      return docs;
    },
  };
}

interface CodexSession {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  firstText: string | null;
  count: number;
}

interface CodexHistoryLine {
  session_id?: string;
  text?: string;
  ts?: number;
}

async function readHistory(file: string): Promise<Map<string, CodexSession>> {
  const sessions = new Map<string, CodexSession>();
  const raw = await safeReadFile(file);
  if (raw === null) return sessions;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: CodexHistoryLine;
    try {
      ev = JSON.parse(line) as CodexHistoryLine;
    } catch {
      continue;
    }
    const sessionId = ev.session_id;
    if (!sessionId) continue;
    const ms = toMs(ev.ts);
    const existing = sessions.get(sessionId);
    if (!existing) {
      sessions.set(sessionId, {
        sessionId,
        startedAt: ms,
        endedAt: ms,
        firstText: ev.text?.trim() || null,
        count: 1,
      });
    } else {
      existing.startedAt = Math.min(existing.startedAt, ms);
      existing.endedAt = Math.max(existing.endedAt, ms);
      existing.count++;
      if (!existing.firstText && ev.text?.trim()) existing.firstText = ev.text.trim();
    }
  }
  return sessions;
}

/** Codex history `ts` may be epoch seconds or ms; normalize to ms. */
function toMs(ts: number | undefined): number {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

function cursorMs(cursor: WatchCursor | null): number {
  if (!cursor) return 0;
  const t = Date.parse(cursor.position);
  return Number.isFinite(t) ? t : 0;
}

export const codexSource = createCodexSource();
