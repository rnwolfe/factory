import { describe, expect, test } from "bun:test";
import {
  CONTROL_PLANE_ENV_VARS,
  controlPlaneUnsetPrefix,
  scrubControlPlaneEnv,
} from "../src/env.ts";

/**
 * A self-hosting run must never inherit the daemon's control-plane env — those
 * vars point Factory tooling at the LIVE instance (DB / tmux server). If they
 * leak, a run's `bun run seed` / `db:migrate` / daemon boot operates on
 * production and can reap the operator's real in-flight runs. These tests pin
 * both defenses (env scrub + shell unset).
 */
describe("control-plane env isolation", () => {
  test("scrubControlPlaneEnv drops every control-plane var, keeps the rest", () => {
    const source = {
      FACTORY_HOME: "/home/rnwolfe/.factory-live",
      FACTORY_DB: "/home/rnwolfe/.factory-live/data.db",
      FACTORY_TMUX_SOCKET: "factory-live",
      PATH: "/usr/bin",
      HOME: "/home/rnwolfe",
      GIT_AUTHOR_NAME: "keep me",
    };
    const scrubbed = scrubControlPlaneEnv(source);
    for (const v of CONTROL_PLANE_ENV_VARS) {
      expect(scrubbed[v]).toBeUndefined();
    }
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/rnwolfe");
    expect(scrubbed.GIT_AUTHOR_NAME).toBe("keep me");
  });

  test("scrubControlPlaneEnv skips undefined values", () => {
    const scrubbed = scrubControlPlaneEnv({ A: "1", B: undefined });
    expect(scrubbed.A).toBe("1");
    expect("B" in scrubbed).toBe(false);
  });

  test("controlPlaneUnsetPrefix unsets exactly the control-plane vars", () => {
    const prefix = controlPlaneUnsetPrefix();
    expect(prefix).toBe("unset FACTORY_HOME FACTORY_DB FACTORY_TMUX_SOCKET; ");
    for (const v of CONTROL_PLANE_ENV_VARS) {
      expect(prefix).toContain(v);
    }
  });
});
