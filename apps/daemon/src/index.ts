import { createDb, runMigrations, schema } from "@factory/db";
import { resizeTmuxWindow, sendKeysToTmux } from "@factory/runtime";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { eq } from "drizzle-orm";
import { bindAgentBudgetConfig, getAgentBudgetSeconds } from "./agent-budget.ts";
import { authorizeRequest } from "./auth.ts";
import { ensureVapid, type FactoryConfig, loadConfig, writeInitialConfig } from "./config.ts";
import type { DaemonContext } from "./context.ts";
import { recoverOrphanedDeferredTasks } from "./deferred-tasks/orchestrate.ts";
import { EventBus } from "./events.ts";
import { githubAppClientFromConfig } from "./github/app-auth.ts";
import { githubWebhookRoute } from "./github/webhook.ts";
import { buildHealth } from "./health.ts";
import { startInboxSnoozeResurfacer } from "./inbox-resurface.ts";
import {
  recoverOrphanedInterventions,
  tmuxNameForIntervention,
} from "./interventions/orchestrate.ts";
import { backfillMetrics, createMetricsRollupJob } from "./metrics/rollup.ts";
import { migrateQualityConfigs } from "./projects/quality-config.ts";
import { configureGithubTaskBackend } from "./projects/tasks.ts";
import { startPushDispatcher } from "./push/dispatcher.ts";
import { appRouter } from "./router.ts";
import { ScriptRegistry } from "./scripts/registry.ts";
import { notifyReady } from "./sd-notify.ts";
import { recoverOrphanedSessions, tmuxNameForSession } from "./sessions/orchestrate.ts";
import { applySettingsFromDb } from "./settings/store.ts";
import { makeStaticHandler } from "./static.ts";
import { createDbCursorStore } from "./watch/cursor-store.ts";
import { filterAlreadyTracked } from "./watch/inband/backlog.ts";
import { surfaceObservations } from "./watch/observation-inbox.ts";
import { persistObservations } from "./watch/observation-store.ts";
import { createSynthesisJob, readWatchSynthesisCadence } from "./watch/synthesis-job.ts";
import { synthesizeObservations } from "./watch/synthesize.ts";
import { WorkerPool } from "./workers/pool.ts";
import { reapOrphanedRuns } from "./workers/recover.ts";
import { RunRegistry } from "./workers/registry.ts";
import { startScheduler } from "./workers/scheduler.ts";
import { startUsageCapResumer } from "./workers/usage-cap.ts";
import { attachWsChannel, detachWsChannel, planWsUpgrade, type WsClientData } from "./ws/hub.ts";

export type { AppRouter } from "./router.ts";

const PORT_RETRY_LIMIT = 10;

function isAddrInUse(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "EADDRINUSE") return true;
  return typeof e.message === "string" && /address already in use|EADDRINUSE/i.test(e.message);
}

/**
 * Run `factory(port)` to start a server bound to `port`. If the port is in
 * use, step forward up to `PORT_RETRY_LIMIT` times and try the next one.
 * Throws if no port in the window is available — the caller should surface
 * that to the operator clearly.
 */
function serveWithPortRetry<T>(startPort: number, factory: (port: number) => T): T {
  let lastErr: unknown;
  for (let i = 0; i < PORT_RETRY_LIMIT; i++) {
    const port = startPort + i;
    try {
      return factory(port);
    } catch (err) {
      lastErr = err;
      if (!isAddrInUse(err)) throw err;
      console.warn(`[factoryd] port ${port} in use — trying ${port + 1}`);
    }
  }
  throw new Error(
    `could not bind any port in [${startPort}, ${startPort + PORT_RETRY_LIMIT - 1}]: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

interface DaemonHandle {
  config: FactoryConfig;
  /** Actual bound port (matters when config.port is 0 / ephemeral). */
  port: number;
  stop: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  let { config, source } = await loadConfig();
  // Persist the synthesized config on first start so the auth token survives
  // across restarts. Without this, every `bun run dev` restart minted a new
  // random token and the operator had to re-paste it into the PWA's auth
  // gate. Persistence is gated on `loadedFromDisk` — we never overwrite an
  // existing config.
  if (!source.loadedFromDisk) {
    const written = await writeInitialConfig(source.configPath, config);
    config = written.config;
    source = { configPath: written.configPath, loadedFromDisk: true };
    console.log(`[factoryd] wrote initial config ${source.configPath}`);
  }
  console.log(`[factoryd] config loaded from ${source.configPath}`);

  // Generate a VAPID keypair if this is the first start without one. Persists
  // back to config.yaml so existing browser subscriptions stay valid across
  // restarts (rotating the keypair would invalidate every subscribed device).
  if (await ensureVapid(config, source.configPath)) {
    console.log(`[factoryd] generated VAPID keypair and wrote to ${source.configPath}`);
  }

  // APNs (Apple's push service) validates the VAPID JWT `sub` claim and
  // rejects subjects with non-routable TLDs — every iOS push attempt
  // returns 403 BadJwtToken when the subject is `mailto:*@localhost`.
  // FCM and Mozilla don't validate, so the failure mode is iOS-only and
  // silent in journalctl. Surface it on every boot so the operator
  // knows where to look without having to walk the whole diagnostic.
  if (config.vapid.subject.includes("@localhost")) {
    console.warn(
      `[factoryd] WARNING: vapid.subject is "${config.vapid.subject}" — APNs (iOS) rejects this with BadJwtToken. Edit ${source.configPath} and set vapid.subject to a real address (e.g. mailto:you@your-domain.com), then restart. Web Push to Chrome/Firefox is unaffected.`,
    );
  }

  // DB
  runMigrations(config.dbPath);
  const db = createDb(config.dbPath);
  // Operator-tunable settings live in the DB (yaml seeds defaults on first
  // boot; DB overrides take precedence afterwards). Mutates `config` in
  // place so all DaemonContext.config readers see the right values without
  // any rewiring.
  applySettingsFromDb(db, config);

  // Wire the GitHub App client for `github-issues`-backed projects (ADR-007).
  // Null when the App isn't configured; opted-in projects then error clearly
  // rather than silently falling back to an empty local task dir.
  configureGithubTaskBackend(githubAppClientFromConfig(config));

  // Bind the live config to the agent-budget singleton. Triage / plan /
  // audit / feedback invocations read from this; mutations through the
  // settings store flow through automatically (config object is shared).
  bindAgentBudgetConfig(config);

  // (Boot-time recovery happens after pool/registry/events are constructed
  //  below — the resume path needs them to re-submit work.)

  // Static PWA (built by `bun run --filter @factory/pwa build`).
  const pwaDist =
    process.env.FACTORY_PWA_DIST ?? new URL("../../pwa/dist", import.meta.url).pathname;
  const serveStatic = makeStaticHandler(pwaDist);

  // Worker pool + registry
  const pool = new WorkerPool(config.maxConcurrentRuns);
  const runs = new RunRegistry();
  const events = new EventBus();
  const scripts = new ScriptRegistry(events);

  // Boot-time recovery for any runs left mid-flight by a prior daemon.
  // Three-tier salvage: log-recovery, --resume the claude session, or mark
  // aborted as a last resort. Resume re-submits to the pool we just built,
  // which is why this lives here and not earlier.
  const reaped = await reapOrphanedRuns({ config, db, events, runs, pool });
  if (reaped.recovered + reaped.resumed + reaped.aborted > 0) {
    console.log(
      `[factoryd] reaped orphaned runs — recovered: ${reaped.recovered}, resumed: ${reaped.resumed}, aborted: ${reaped.aborted}`,
    );
  }
  const orphanedSessions = await recoverOrphanedSessions(db, events);
  if (orphanedSessions > 0) {
    console.log(`[factoryd] aborted ${orphanedSessions} orphaned session(s) on boot`);
  }
  const orphanedInterventions = await recoverOrphanedInterventions(db, events);
  if (orphanedInterventions > 0) {
    console.log(
      `[factoryd] orphaned ${orphanedInterventions} active intervention(s) on boot — operator can intervene again`,
    );
  }
  // Deferred-task subprocesses were daemon-children; we lost the
  // `proc.exited` handle when the daemon went down. Mark any still-running
  // rows as orphaned so the operator can reconcile manually — we don't
  // auto-kill them because long builds may legitimately still be in flight,
  // reparented to init.
  const orphanedDeferred = await recoverOrphanedDeferredTasks(db, events);
  if (orphanedDeferred > 0) {
    console.log(
      `[factoryd] orphaned ${orphanedDeferred} deferred task(s) on boot — operator must reconcile`,
    );
  }

  // Migrate repo-canonical quality config for projects bootstrapped before
  // the Makefile quality interface. Idempotent — rewrites only quality.yaml
  // files still byte-identical to a prior Factory default; never touches a
  // customized config or an existing Makefile.
  const qualityMigrated = await migrateQualityConfigs({ db, gitAuthor: config.gitAuthor });
  if (qualityMigrated > 0) {
    console.log(`[factoryd] migrated quality config for ${qualityMigrated} project(s)`);
  }

  // Web Push: relay attention-worthy events to enrolled browsers. The
  // unsubscribe is held so we can detach on shutdown — without it, the
  // dispatcher would hold a reference to `db` and `config` past stop().
  const stopPushDispatcher = startPushDispatcher({ config, db, events });

  // Auto-resume runs halted by a usage cap once their reset time passes.
  const stopUsageCapResumer = startUsageCapResumer({ config, db, events, runs, pool });

  // Timed inbox snoozes are daemon-owned. The inbox queries already treat
  // expired timestamps as active; this loop makes expiry proactive by clearing
  // the snooze and publishing the same event path as a newly-landed item.
  const stopInboxSnoozeResurfacer = startInboxSnoozeResurfacer({ db, events });

  // Seed the metrics rollups so the ops surface has history on day one and
  // stays fresh across restarts (ADR-013). Fire-and-forget + bounded (last 14
  // UTC days) so it never blocks boot; the daily scheduler job maintains it
  // going forward. Idempotent (upsert).
  void backfillMetrics(db, Date.now() - 14 * 24 * 60 * 60_000, Date.now() + 24 * 60 * 60_000).catch(
    (err) =>
      console.warn(`[metrics] boot backfill failed: ${err instanceof Error ? err.message : err}`),
  );

  // The Watch (ADR-010): proactive scheduler tick. It scans the operator's
  // out-of-band harness work on the operator-tunable `watch-synthesis-cadence`
  // (read live each tick), synthesizes observations via `claude --print`, and
  // persists them deduped to `watch_observations`. Scan positions persist in
  // `watch_cursors` so a restart resumes rather than re-reading. It also drives
  // the daily metrics rollup (ADR-013).
  const scheduler = startScheduler({
    events,
    jobs: [
      createSynthesisJob({
        cadence: () => readWatchSynthesisCadence(db),
        cursors: createDbCursorStore(db),
        synthesize: (records, memories) =>
          synthesizeObservations(records, memories, { budgetSeconds: getAgentBudgetSeconds() }),
        dedupeAgainstBacklog: (obs) => filterAlreadyTracked(db, obs),
        saveObservations: (obs) => {
          // Persist (deduped), then surface the genuinely-new ones to the inbox.
          const { inserted, skipped } = persistObservations(db, obs);
          surfaceObservations(db, events, inserted);
          return { inserted: inserted.length, skipped };
        },
      }),
      createMetricsRollupJob(db),
    ],
  });

  const buildCtx = (req: Request): DaemonContext => ({
    config,
    db,
    events,
    runs,
    pool,
    scripts,
    authorized: authorizeRequest(req, config),
  });

  const server = serveWithPortRetry(config.port, (port) =>
    Bun.serve<WsClientData, never>({
      hostname: config.host,
      port,
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

        // GitHub App webhook (ADR-007). HMAC-verified, not bearer-authed.
        // Gates every delivery on a github-issues-backed project for the repo;
        // unmatched repos (the App is installed on all of them) are no-ops.
        if (url.pathname === "/webhooks/github" && req.method === "POST") {
          return githubWebhookRoute(req, config, db, events);
        }

        // Health endpoint bypasses tRPC for ops checks (systemctl status,
        // factory upgrade post-restart probe, doctor, etc.).
        if (url.pathname === "/health") {
          return buildHealth(db).then((info) =>
            Response.json(info, { status: info.status === "ok" ? 200 : 503 }),
          );
        }

        // Static SPA — serves the built PWA when present.
        const staticResponse = serveStatic(req);
        if (staticResponse) return staticResponse;

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
            scripts,
            authorized: true,
          } satisfies DaemonContext;
          attachWsChannel(ws, ctx);
        },
        message(ws, msg) {
          // Pane channel carries operator keystrokes for runs, ad-hoc
          // sessions, and operator interventions. The runId field on
          // ws.data is the carrier id — cuid namespace is shared across
          // all three primitives, so a single lookup chain (interventions
          // → sessions → runs) finds the right tmux name.
          //
          // Frame convention:
          //  - Binary frames → keystrokes (sent verbatim to the pane).
          //  - Text frames → JSON control envelopes, currently just
          //    `{type:"resize",cols,rows}`. xterm.js on the client always
          //    encodes keystrokes to bytes before sending, so a string
          //    frame here is unambiguously a control message.
          if (ws.data.channel !== "pane") return;
          const runId = ws.data.runId;
          if (!runId) return;
          void (async () => {
            // Interventions registry first (in-memory, no DB hit).
            let sessionName = tmuxNameForIntervention(runId);
            if (!sessionName) sessionName = tmuxNameForSession(runId);
            if (!sessionName) {
              const row = await db
                .select({ tmuxSession: schema.runs.tmuxSession })
                .from(schema.runs)
                .where(eq(schema.runs.id, runId))
                .get();
              sessionName = row?.tmuxSession ?? null;
            }
            if (!sessionName) return;
            if (typeof msg === "string") {
              let parsed: unknown;
              try {
                parsed = JSON.parse(msg);
              } catch {
                return;
              }
              if (!parsed || typeof parsed !== "object") return;
              const ctl = parsed as { type?: unknown; cols?: unknown; rows?: unknown };
              if (
                ctl.type === "resize" &&
                typeof ctl.cols === "number" &&
                typeof ctl.rows === "number"
              ) {
                await resizeTmuxWindow(sessionName, ctl.cols, ctl.rows);
              }
              return;
            }
            await sendKeysToTmux(sessionName, new Uint8Array(msg as Buffer));
          })();
        },
        close(ws) {
          detachWsChannel(ws);
        },
      },
    }),
  );

  const boundPort = server.port ?? config.port;
  if (boundPort !== config.port) {
    console.log(`[factoryd] port ${config.port} unavailable — bound ${boundPort} instead`);
  }
  console.log(`[factoryd] listening on http://${config.host}:${boundPort}`);
  // Loud warning for localhost-only binds — operators expect to reach the
  // PWA from their phone over LAN; a 127.0.0.1 bind silently breaks that.
  // Common cause: hand-edited config.yaml or a stale value from an old
  // install. The fix is one line — point operators at it.
  if (config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1") {
    console.warn(
      `[factoryd] WARNING: bound to ${config.host} — LAN clients (phone, other devices) cannot reach this daemon. set host: "0.0.0.0" in ${source.configPath} and restart.`,
    );
  }
  console.log(`[factoryd] tRPC endpoint:   /trpc`);
  console.log(`[factoryd] WS channels:     /ws/events  /ws/pane  /ws/inbox  /ws/script`);
  console.log(`[factoryd] workdir:         ${config.workdir}`);
  console.log(`[factoryd] db:              ${config.dbPath}`);
  console.log(`[factoryd] max concurrent runs: ${config.maxConcurrentRuns}`);

  // Tell systemd we're ready (no-op outside Type=notify units). After this
  // point the unit is considered Started; `factory upgrade`'s health probe
  // will see the new version.
  await notifyReady();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[factoryd] shutting down…");
    server.stop();
    runs.abortAll();
    scripts.killAll();
    stopPushDispatcher();
    stopUsageCapResumer();
    stopInboxSnoozeResurfacer();
    scheduler.stop();
    await pool.drain();
    console.log("[factoryd] shutdown complete.");
  };

  return { config, port: boundPort, stop };
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
