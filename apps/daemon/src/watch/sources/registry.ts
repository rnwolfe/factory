import { claudeCodeSource } from "./claude-code.ts";
import { codexSource } from "./codex.ts";
import type { HarnessSource } from "./types.ts";

/**
 * Single source of truth for every harness The Watch can observe (ADR-010 §2),
 * modelled on `apps/daemon/src/agents/registry.ts`. Adding a harness (Cursor,
 * Amp, Gemini-CLI, …) is one {@link HarnessSource} implementation + one entry
 * below — the scheduler job, synthesizer, cursor store, and any PWA surface all
 * iterate this registry instead of switching on a source id.
 */
export const HARNESS_SOURCE_REGISTRY: Record<string, HarnessSource> = {
  [claudeCodeSource.id]: claudeCodeSource,
  [codexSource.id]: codexSource,
};

export function listHarnessSources(): HarnessSource[] {
  return Object.values(HARNESS_SOURCE_REGISTRY);
}

export function getHarnessSource(id: string): HarnessSource | undefined {
  return HARNESS_SOURCE_REGISTRY[id];
}

/** Sources whose local store actually exists on this host. */
export async function availableHarnessSources(): Promise<HarnessSource[]> {
  const all = listHarnessSources();
  const present = await Promise.all(all.map((s) => s.isAvailable()));
  return all.filter((_, i) => present[i]);
}
