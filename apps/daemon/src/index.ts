import { createDb, runMigrations } from "@factory/db";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { authorizeRequest } from "./auth.ts";
import { type FactoryConfig, loadConfig } from "./config.ts";
import type { DaemonContext } from "./context.ts";
import { EventBus } from "./events.ts";
import { appRouter } from "./router.ts";
import { WorkerPool } from "./workers/pool.ts";
import { RunRegistry } from "./workers/registry.ts";
import { attachWsChannel, detachWsChannel, planWsUpgrade, type WsClientData } from "./ws/hub.ts";

interface DaemonHandle {
  config: FactoryConfig;
  /** Actual bound port (matters when config.port is 0 / ephemeral). */
  port: number;
  stop: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  const { config, source } = await loadConfig();
  console.log(
    `[factoryd] config ${source.loadedFromDisk ? "loaded" : "synthesized"} from ${source.configPath}`,
  );
  if (!source.loadedFromDisk) {
    console.log(`[factoryd] no config on disk — using ephemeral token: ${config.auth.token}`);
    console.log("[factoryd] run `bun scripts/factoryd-init.ts` to persist a config.");
  }

  // DB
  runMigrations(config.dbPath);
  const db = createDb(config.dbPath);

  // Worker pool + registry
  const pool = new WorkerPool(config.maxConcurrentRuns);
  const runs = new RunRegistry();
  const events = new EventBus();

  const buildCtx = (req: Request): DaemonContext => ({
    config,
    db,
    events,
    runs,
    pool,
    authorized: authorizeRequest(req, config),
  });

  const server = Bun.serve<WsClientData, never>({
    hostname: config.host,
    port: config.port,
    fetch(req, srv) {
      const url = new URL(req.url);

      // WebSocket upgrade routing
      if (url.pathname.startsWith("/ws/")) {
        const plan = planWsUpgrade(req, buildCtx(req));
        if (plan.kind === "deny") {
          return new Response(plan.reason, { status: plan.status });
        }
        if (plan.kind === "upgrade") {
          const ok = srv.upgrade(req, { data: plan.data });
          if (ok) return undefined;
          return new Response("upgrade failed", { status: 500 });
        }
      }

      // tRPC router at /trpc/*
      if (url.pathname.startsWith("/trpc/") || url.pathname === "/trpc") {
        return fetchRequestHandler({
          endpoint: "/trpc",
          req,
          router: appRouter,
          createContext: () => buildCtx(req),
          onError({ error, path }) {
            console.error(`[trpc] ${path ?? "?"}: ${error.message}`);
          },
        });
      }

      // Tiny health endpoint that bypasses tRPC for ops checks.
      if (url.pathname === "/health") {
        return Response.json({ ok: true, ts: Date.now() });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const ctx = {
          config,
          db,
          events,
          runs,
          pool,
          authorized: true,
        } satisfies DaemonContext;
        attachWsChannel(ws, ctx);
      },
      message(ws, msg) {
        // Pane channel: forward inbound bytes/strings to a tmux send-keys hook.
        // M4 keeps the inbound side as a no-op; the daemon already drives runs
        // via tRPC. The PWA will use this channel for keystrokes in M6.
        if (ws.data.channel !== "pane") return;
        // For now, silently accept and discard.
        void msg;
      },
      close(ws) {
        detachWsChannel(ws);
      },
    },
  });

  console.log(`[factoryd] listening on http://${config.host}:${config.port}`);
  console.log(`[factoryd] tRPC endpoint:   /trpc`);
  console.log(`[factoryd] WS channels:     /ws/events  /ws/pane  /ws/inbox`);
  console.log(`[factoryd] workdir:         ${config.workdir}`);
  console.log(`[factoryd] db:              ${config.dbPath}`);
  console.log(`[factoryd] max concurrent runs: ${config.maxConcurrentRuns}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[factoryd] shutting down…");
    server.stop();
    runs.abortAll();
    await pool.drain();
    console.log("[factoryd] shutdown complete.");
  };

  return { config, port: server.port ?? config.port, stop };
}

if (import.meta.main) {
  const handle = await startDaemon();
  const onSignal = async (sig: string) => {
    console.log(`\n[factoryd] received ${sig}`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
}
