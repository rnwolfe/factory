import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpToLine } from "lucide-react";
import { trpc } from "../lib/trpc.ts";

/**
 * Sync status of the workdir branch vs. its configured upstream, mirrored from
 * the daemon's `WorkdirSnapshot.upstream` (see apps/daemon/src/projects/workdir.ts).
 * ahead/behind are as-of-last-fetch — the snapshot never triggers a network fetch.
 */
export interface UpstreamStatus {
  configured: boolean;
  branch: string | null;
  remoteRef: string | null;
  ahead: number;
  behind: number;
  state: "up_to_date" | "ahead" | "behind" | "diverged" | "no_remote";
}

const CHIP_CLASS: Record<UpstreamStatus["state"], string> = {
  up_to_date: "chip-greenlit",
  ahead: "chip-accent",
  behind: "chip-parked",
  diverged: "chip-trashed",
  no_remote: "",
};

function chipLabel(u: UpstreamStatus): string {
  switch (u.state) {
    case "up_to_date":
      return "in sync";
    case "ahead":
      return `ahead ${u.ahead}`;
    case "behind":
      return `behind ${u.behind}`;
    case "diverged":
      return `↑${u.ahead} ↓${u.behind}`;
    default:
      return "no remote";
  }
}

/**
 * Presentational upstream chip + guarded push affordance. Pure: the push action
 * is a callback and the pending/error state is passed in, so it renders without
 * a query client (mirrors WatchPanelView). The push button appears ONLY when the
 * worktree is clean AND strictly ahead — every other state (behind / diverged /
 * up-to-date / no remote) shows the chip read-only. This matches the daemon-side
 * guard in apps/daemon/src/projects/push.ts, which refuses to push in any
 * non-(clean & ahead) state.
 */
export function UpstreamChipView({
  upstream,
  dirty,
  onPush,
  pushing = false,
  error = null,
  className,
}: {
  upstream: UpstreamStatus | undefined;
  dirty: boolean;
  onPush: () => void;
  pushing?: boolean;
  error?: string | null;
  className?: string;
}) {
  if (!upstream) return null;

  const canPush = upstream.state === "ahead" && !dirty;
  // behind / diverged still have a real upstream but can't be fast-forwarded from
  // here — the operator has to pull/reconcile in a terminal.
  const needsManual = upstream.state === "behind" || upstream.state === "diverged";
  const fetchNote =
    upstream.state === "no_remote"
      ? "no upstream tracking ref configured for the current branch"
      : `${upstream.branch ?? "HEAD"} vs ${upstream.remoteRef ?? "upstream"} — ahead/behind as of last fetch (Factory never fetches)`;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className ?? ""}`}>
      <span className={`chip ${CHIP_CLASS[upstream.state]}`} title={fetchNote}>
        {chipLabel(upstream)}
      </span>
      {canPush ? (
        <button
          type="button"
          onClick={onPush}
          disabled={pushing}
          className="chip chip-accent hover:border-[var(--color-line-bright)] disabled:opacity-60"
          title={`push ${upstream.ahead} commit(s) to ${upstream.remoteRef} (fast-forward, no force)`}
        >
          <ArrowUpToLine size={11} />
          {pushing ? "pushing…" : "push"}
        </button>
      ) : dirty && upstream.state === "ahead" ? (
        <span
          className="mono text-[10px] text-[var(--color-fg-3)]"
          title="commit or discard uncommitted changes before pushing"
        >
          commit to push
        </span>
      ) : needsManual ? (
        <span className="mono text-[10px] text-[var(--color-fg-3)]">pull/resolve manually</span>
      ) : null}
      {error ? (
        <span className="mono text-[10px] text-[var(--color-verdict-trashed)]" title="push failed">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Upstream sync status chip + guarded push (feature plan lro3heax). Wires the
 * guarded `projects.pushUpstream` mutation to {@link UpstreamChipView} and, on
 * success, refreshes the workdir snapshot so the chip reflects the new
 * ahead/behind state (typically dropping to `in sync`).
 */
export function UpstreamChip({
  projectId,
  upstream,
  dirty,
  className,
}: {
  projectId: string;
  upstream: UpstreamStatus | undefined;
  dirty: boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const push = useMutation({
    mutationFn: () => trpc.projects.pushUpstream.mutate({ id: projectId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.workdir", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
    },
  });

  return (
    <UpstreamChipView
      upstream={upstream}
      dirty={dirty}
      onPush={() => push.mutate()}
      pushing={push.isPending}
      error={push.isError ? (push.error as Error).message : null}
      className={className}
    />
  );
}
