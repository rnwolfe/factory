import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ChangelogBullet {
  /** Bold lead-in (`**…**` prefix), if present. */
  lead: string | null;
  /** Bullet body — the prose after the bold lead-in (or the whole bullet if none). */
  body: string;
}

export interface ChangelogSection {
  heading: string;
  bullets: ChangelogBullet[];
}

export interface ChangelogEntry {
  /** Version without the leading `v` — `"0.11.0"`. */
  version: string;
  /** Date in `YYYY-MM-DD` form, or `null` if unparseable. */
  date: string | null;
  /** Free-prose paragraph(s) between the `##` header and the first `###`. */
  intro: string;
  sections: ChangelogSection[];
}

const VERSION_HEADER_RE =
  /^##\s+v(?<version>\d+\.\d+\.\d+(?:[-\w.]*)?)(?:\s+[—-]\s+(?<date>\d{4}-\d{2}-\d{2}))?\s*$/;
const SECTION_HEADER_RE = /^###\s+(?<heading>.+?)\s*$/;
const BULLET_RE = /^[-*]\s+(?<body>.+)$/;
const BOLD_LEAD_RE = /^\*\*(?<lead>[^*]+?)\*\*\s*(?<rest>.*)$/;

let cached: { entries: ChangelogEntry[]; mtimeMs: number; filePath: string } | null = null;

/**
 * Resolve the repo-root CHANGELOG.md by walking up from a starting directory
 * until either it's found or we hit the filesystem root.
 *
 * The daemon is launched via `bun run --filter @factory/daemon start`, which
 * chdirs into `apps/daemon/` before invoking the script — so `process.cwd()`
 * is *not* the repo root. We walk up from there to find the workspace root's
 * CHANGELOG.md, the same way `git` walks up to find `.git/`.
 */
function findChangelogPath(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "CHANGELOG.md");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Parse the repo's CHANGELOG.md into structured entries. Caches on file mtime
 * so we don't re-parse on every query.
 */
export function loadChangelog(startDir: string = process.cwd()): ChangelogEntry[] {
  const filePath = findChangelogPath(startDir);
  if (!filePath) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = Bun.file(filePath).lastModified || 0;
  } catch {
    // Bun.file().lastModified may throw on exotic filesystems; fall back to
    // unconditional re-read.
  }
  if (cached && cached.filePath === filePath && cached.mtimeMs === mtimeMs) {
    return cached.entries;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const entries = parseChangelog(raw);
  cached = { entries, mtimeMs, filePath };
  return entries;
}

export function parseChangelog(raw: string): ChangelogEntry[] {
  const lines = raw.split("\n");
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentSection: ChangelogSection | null = null;
  let introBuf: string[] = [];

  const flushIntro = () => {
    if (current && introBuf.length > 0) {
      current.intro = introBuf.join("\n").trim();
      introBuf = [];
    }
  };

  for (const line of lines) {
    const versionMatch = VERSION_HEADER_RE.exec(line);
    const versionFromMatch = versionMatch?.groups?.version;
    if (versionFromMatch) {
      flushIntro();
      if (current) entries.push(current);
      current = {
        version: versionFromMatch,
        date: versionMatch?.groups?.date ?? null,
        intro: "",
        sections: [],
      };
      currentSection = null;
      introBuf = [];
      continue;
    }

    if (!current) continue;
    const stableSection = currentSection;

    const sectionMatch = SECTION_HEADER_RE.exec(line);
    const heading = sectionMatch?.groups?.heading;
    if (heading) {
      flushIntro();
      currentSection = { heading, bullets: [] };
      current.sections.push(currentSection);
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    const bulletBody = bulletMatch?.groups?.body;
    if (bulletBody && stableSection) {
      stableSection.bullets.push(parseBullet(bulletBody));
      continue;
    }

    // Continuation line for the previous bullet (indented body).
    if (stableSection && stableSection.bullets.length > 0 && /^\s+\S/.test(line)) {
      const last = stableSection.bullets[stableSection.bullets.length - 1];
      if (last) last.body = `${last.body} ${line.trim()}`.trim();
      continue;
    }

    // Otherwise it's intro prose (between the version header and first section).
    if (!stableSection && line.trim().length > 0) {
      introBuf.push(line);
    }
  }

  flushIntro();
  if (current) entries.push(current);
  return entries;
}

function parseBullet(body: string): ChangelogBullet {
  const m = BOLD_LEAD_RE.exec(body);
  const lead = m?.groups?.lead;
  const rest = m?.groups?.rest;
  if (lead && rest !== undefined) {
    return {
      lead: lead.trim().replace(/\.$/, ""),
      body: rest.trim(),
    };
  }
  return { lead: null, body: body.trim() };
}

/** Test seam — clears the mtime cache so unit tests can re-parse. */
export function _resetChangelogCache(): void {
  cached = null;
}
