import type { Db } from "@factory/db";
import type { FactoryConfig } from "./config.ts";
import type { EventBus } from "./events.ts";
import type { WorkerPool } from "./workers/pool.ts";
import type { RunRegistry } from "./workers/registry.ts";

export interface DaemonContext {
  config: FactoryConfig;
  db: Db;
  events: EventBus;
  runs: RunRegistry;
  pool: WorkerPool;
  /** True after the bearer-token middleware has authorized the request. */
  authorized: boolean;
}
