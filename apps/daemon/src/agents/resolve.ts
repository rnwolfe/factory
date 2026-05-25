import type { Db } from "@factory/db";
import {
  type AgentName,
  agentSupportsResume,
  SUPPORTED_AGENT_NAMES,
} from "../plans/invoke-claude.ts";
import { readAllSettings, readOpsSettings } from "../settings/store.ts";

/**
 * Single source of truth for "which headless agent should this code path
 * dispatch to". The chain is:
 *
 *   explicit override → task.frontmatter.agent → settings.default-agent
 *     → "claude-code"
 *
 * Per-project agent selection (a `projects.agent_name` column wired into
 * the chain between task-frontmatter and settings.default-agent) is the
 * follow-up in task-020 — until then, the chain skips that layer.
 *
 * Callers pass whichever inputs they have (most non-run sites only have
 * the db reference and fall through to settings). Run submission (the
 * one site that already had partial wiring) has its own combined logic
 * in `workers/submit.ts` — this helper covers the daemon's
 * non-`runtime.spawn` invocations.
 */
export interface ResolveAgentInput {
  /** Explicit override from request input (PWA picker, etc.). */
  override?: string | null;
  /** Task frontmatter value when invocation is task-bound. */
  taskFrontmatterAgent?: string | null;
}

/**
 * Resolve the effective agent for a non-run-submission code path.
 *
 * Reads settings.default-agent from the DB; that's typically a hot table
 * cached by the daemon, so calls here are cheap. The function is sync to
 * match the sync settings reader.
 */
export function resolveAgent(db: Db, input: ResolveAgentInput = {}): AgentName {
  const candidates: Array<string | null | undefined> = [input.override, input.taskFrontmatterAgent];

  for (const c of candidates) {
    const norm = normalizeAgent(c);
    if (norm) return norm;
  }

  // Fall through to the DB-stored default.
  const ops = readOpsSettings(readAllSettings(db));
  const fromSettings = normalizeAgent(ops.defaultAgent);
  if (fromSettings) return fromSettings;

  return "claude-code";
}

/** Normalize a raw string to a supported AgentName, or null. */
export function normalizeAgent(raw: string | null | undefined): AgentName | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  return (SUPPORTED_AGENT_NAMES as readonly string[]).includes(v) ? (v as AgentName) : null;
}

/**
 * Sanity-check that a code path which depends on session resume is not
 * being asked to use an agent that doesn't support it. Throws a clear
 * error pointing at the parity inventory so the operator can act.
 *
 * Resume-dependent sites: plan iteration follow-ups, audit comment
 * replies, feedback follow-ups. See `docs/internal/codex-parity.md`.
 */
export function assertAgentSupportsResume(agent: AgentName, sitelabel: string): void {
  if (agentSupportsResume(agent)) return;
  throw new Error(
    `${sitelabel} requires session resume, which agent "${agent}" does not support. ` +
      `Switch this project/run to claude-code, or wait for the resume-fallback follow-up. ` +
      `See docs/internal/codex-parity.md.`,
  );
}
