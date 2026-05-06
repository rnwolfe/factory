import { probeHealth } from "../lib/health-probe.ts";

export interface ProbeOutcome {
  ok: boolean;
  reason: string | null;
  version: string | null;
}

/**
 * Poll /health until version reflects the new sha (short prefix match) or
 * the timeout elapses. The daemon sets FACTORY_VERSION before exec'ing
 * the bun process — see the `factory upgrade` orchestrator for that.
 */
export async function probeUntilVersion(
  expectedVersion: string,
  totalMs = 15_000,
  intervalMs = 500,
): Promise<ProbeOutcome> {
  const deadline = Date.now() + totalMs;
  let lastErr: string | null = null;
  while (Date.now() < deadline) {
    const r = await probeHealth(intervalMs);
    if (r.status === "ok" && r.version && versionMatches(r.version, expectedVersion)) {
      return { ok: true, reason: null, version: r.version };
    }
    lastErr =
      r.status === "unreachable"
        ? `unreachable (${r.error ?? "no response"})`
        : `version=${r.version ?? "?"} (expected ${expectedVersion})`;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, reason: lastErr ?? "timeout", version: null };
}

function versionMatches(actual: string, expected: string): boolean {
  // The daemon reports either a tag (v1.2.3) or a sha7 — compare loosely.
  if (actual === expected) return true;
  if (expected.length >= 7 && actual.includes(expected.slice(0, 7))) return true;
  if (actual.length >= 7 && expected.includes(actual.slice(0, 7))) return true;
  return false;
}
