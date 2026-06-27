/**
 * The Watch — pluggable harness sources (ADR-010 §2).
 *
 * A "harness source" is any local record of engineering work Factory can
 * observe (Claude Code, Codex, …). The interface is deliberately small and
 * source-agnostic: every consumer iterates {@link HARNESS_SOURCE_REGISTRY}
 * rather than switching on a source id — exactly the discipline of
 * `apps/daemon/src/agents/registry.ts`. Adding a harness is one
 * {@link HarnessSource} implementation + one registry entry; the scheduler job,
 * the synthesizer, the cursor store, and any future PWA surface pick it up for
 * free.
 *
 * Sources are strictly READ-ONLY over local disk and must skip secret files
 * (`.env*`). They never write — synthesis and promotion happen downstream.
 */

/** A typed extract from a work session — raw material for synthesis. */
export interface WorkSignal {
  kind: "correction" | "repeated-step" | "new-tool" | "ritual" | "note";
  detail: string;
}

/** A normalized unit of out-of-band work, emitted by any source. */
export interface WorkRecord {
  sourceId: string;
  /** Stable id within the source (e.g. the session uuid). */
  sessionId: string;
  /** The cwd / repo the work targeted, if discoverable. */
  projectPath: string | null;
  gitBranch: string | null;
  /** epoch ms */
  startedAt: number;
  /** epoch ms, or null if a single-instant record. */
  endedAt: number | null;
  /** Short human summary of the session's intent. */
  title: string;
  /** What happened: counts, branch, outcome — kept lightweight here. */
  summary: string;
  signals: WorkSignal[];
}

/** Opaque, per-source incremental-scan cursor. */
export interface WatchCursor {
  sourceId: string;
  /** Source-defined; here, the ISO timestamp of the newest processed work. */
  position: string;
}

/** An existing curated memory doc a harness maintains. */
export interface MemoryDoc {
  sourceId: string;
  path: string;
  title: string;
  body: string;
}

export interface HarnessSource {
  readonly id: string;
  readonly label: string;
  /** Does this harness's local store exist on this host? */
  isAvailable(): Promise<boolean>;
  /** READ-ONLY incremental scan of work sessions since `cursor`. */
  scan(cursor: WatchCursor | null): Promise<{ records: WorkRecord[]; next: WatchCursor }>;
  /**
   * Existing curated memory docs this harness maintains. Read on the first
   * synthesis pass so day-one operator-memory is grounded in what's already
   * been learned (ADR-010 §4). Input only — never the store Factory writes to.
   */
  readMemories(): Promise<MemoryDoc[]>;
}

/** True for `.env`, `.env.local`, etc. — never read by a source. */
export function isSecretFile(name: string): boolean {
  return /(^|\/)\.env(\.|$)/.test(name);
}
