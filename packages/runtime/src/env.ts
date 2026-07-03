/**
 * Factory control-plane env vars that must NEVER reach an agent run.
 *
 * The daemon reads these to locate its OWN live instance:
 *   - `FACTORY_HOME` / `FACTORY_DB` → the live SQLite DB path
 *     (`getDefaultDbPath` in @factory/db resolves `~/.factory-live/data.db`);
 *   - `FACTORY_TMUX_SOCKET` → the daemon's run-pane tmux server.
 *
 * An agent run inherits the daemon's environment. For a **self-hosting run**
 * (an agent working on the Factory repo itself), that means its own
 * `bun run seed` / `bun run db:migrate` / test suite / any daemon boot would
 * resolve to the LIVE production instance — migrating/seeding the live DB, or
 * (via `reapOrphanedRuns` at daemon boot) marking the operator's genuinely
 * running runs `aborted` ("orphaned by a daemon restart") without killing them,
 * stranding zombie processes. Non-Factory runs don't run Factory tooling so are
 * unaffected in practice, but the blast radius is unacceptable — scrub for all.
 *
 * The agent operates on its git worktree, not the control plane, so it never
 * needs these; a run that genuinely wants a Factory DB must create a scratch
 * one explicitly.
 */
export const CONTROL_PLANE_ENV_VARS = [
  "FACTORY_HOME",
  "FACTORY_DB",
  "FACTORY_TMUX_SOCKET",
] as const;

/** A copy of `source` with every control-plane var removed. */
export function scrubControlPlaneEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const drop = new Set<string>(CONTROL_PLANE_ENV_VARS);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * A `sh` fragment that unsets the control-plane vars, for prefixing a pane
 * command. Belt-and-suspenders alongside `scrubControlPlaneEnv`: a tmux pane
 * inherits the tmux *server's* global environment (the server was started by
 * the daemon, which has these set), so removing them from the per-pane `-e`
 * overrides is not enough on its own — the shell must clear them too.
 */
export function controlPlaneUnsetPrefix(): string {
  return `unset ${CONTROL_PLANE_ENV_VARS.join(" ")}; `;
}
