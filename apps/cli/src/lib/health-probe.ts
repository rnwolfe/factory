export interface ProbeResult {
  ok: boolean;
  status: "ok" | "degraded" | "unreachable";
  version?: string;
  uptime_ms?: number;
  active_runs?: number;
  active_sessions?: number;
  error?: string;
}

/**
 * GET /health on the local daemon. Test seam: FACTORY_CLI_HEALTH_URL.
 */
export async function probeHealth(timeoutMs = 1500): Promise<ProbeResult> {
  const url = process.env.FACTORY_CLI_HEALTH_URL || "http://127.0.0.1:5174/health";
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const body = (await res.json()) as Record<string, unknown>;
    const ok = res.status === 200 && body.status === "ok";
    return {
      ok,
      status: (body.status as ProbeResult["status"]) ?? "degraded",
      version: typeof body.version === "string" ? body.version : undefined,
      uptime_ms: typeof body.uptime_ms === "number" ? body.uptime_ms : undefined,
      active_runs: typeof body.active_runs === "number" ? body.active_runs : undefined,
      active_sessions: typeof body.active_sessions === "number" ? body.active_sessions : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      status: "unreachable",
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(t);
  }
}

export function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
