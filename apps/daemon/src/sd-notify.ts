import { spawn as bunSpawn } from "bun";

/**
 * Notify systemd of a state change. We shell out to `systemd-notify` rather
 * than implementing the AF_UNIX SOCK_DGRAM dance ourselves — node's dgram
 * doesn't expose unix_dgram cleanly, and `systemd-notify` is shipped on
 * every host where `Type=notify` makes sense.
 *
 * No-op when $NOTIFY_SOCKET is unset (dev / tests / non-systemd hosts).
 * Non-fatal on failure: a startup that can't send READY=1 should still
 * boot, just without systemd seeing it as ready.
 */
export async function sdNotify(state: string): Promise<void> {
  if (!process.env.NOTIFY_SOCKET) return;
  try {
    const proc = bunSpawn({
      cmd: ["systemd-notify", state],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.warn(`[factoryd] systemd-notify ${state} exit ${code}: ${stderr.trim()}`);
    }
  } catch (err) {
    console.warn(`[factoryd] systemd-notify unavailable: ${(err as Error).message}`);
  }
}

export async function notifyReady(): Promise<void> {
  await sdNotify("READY=1");
}
