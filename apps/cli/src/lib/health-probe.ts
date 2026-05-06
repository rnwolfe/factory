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
 * Resolve the daemon's port. Override precedence: FACTORY_CLI_PORT env var,
 * then $FACTORY_HOME/config.yaml `port` field (the daemon's own config),
 * then 4080 (the daemon's compile-time default).
 */
async function resolveDaemonPort(): Promise<number> {
  const envPort = process.env.FACTORY_CLI_PORT;
  if (envPort) {
    const n = Number.parseInt(envPort, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Read the daemon's own config — the CLI runs from the operator's account
  // so $FACTORY_HOME (or ~/.factory) is the daemon's config dir.
  const home = process.env.FACTORY_HOME;
  const path = await import("node:path");
  const fs = await import("node:fs");
  const configPath = path.join(home || `${process.env.HOME ?? ""}/.factory`, "config.yaml");
  if (fs.existsSync(configPath)) {
    try {
      const yaml = await import("yaml");
      const text = fs.readFileSync(configPath, "utf8");
      const parsed = yaml.parse(text) as { port?: number } | null;
      if (parsed && typeof parsed.port === "number" && parsed.port > 0) return parsed.port;
    } catch {
      // fall through
    }
  }
  return 4080;
}

/**
 * GET /health on the local daemon. Test seam: FACTORY_CLI_HEALTH_URL trumps
 * the resolved port entirely.
 */
export async function probeHealth(timeoutMs = 1500): Promise<ProbeResult> {
  const url =
    process.env.FACTORY_CLI_HEALTH_URL || `http://127.0.0.1:${await resolveDaemonPort()}/health`;
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
