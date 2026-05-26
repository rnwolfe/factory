import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Terminal } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

/**
 * Session modes mirror the daemon-side sessionModeEnum. `shell` is the
 * harness-free path; every other id names an agent from the registry. Adding
 * a new agent extends both this picker and the daemon's launch path through
 * a single registry-entry edit — see `apps/daemon/src/agents/registry.ts`.
 *
 * Legacy session rows may still carry mode `"claude"` (pre-rename); display
 * uses the canonical labels but the type accepts the alias for back-compat
 * with sessions in-flight at migration time.
 */
type SessionMode = "shell" | "claude-code" | "codex";
type StoredSessionMode = SessionMode | "claude";

const MODE_LABELS: Record<SessionMode, string> = {
  "claude-code": "claude",
  codex: "codex",
  shell: "shell",
};

const MODE_OPTIONS: ReadonlyArray<SessionMode> = ["claude-code", "codex", "shell"];

function displayMode(m: StoredSessionMode): string {
  return MODE_LABELS[(m === "claude" ? "claude-code" : m) as SessionMode];
}

interface SessionRow {
  id: string;
  projectId: string;
  status: "running" | "ended" | "merged" | "merge_failed" | "aborted";
  mode: StoredSessionMode;
  description: string | null;
  branchName: string;
  startedAt: number;
  endedAt: number | null;
  commitCount: number;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function chipClass(status: SessionRow["status"]): string {
  if (status === "running") return "status-in_progress";
  if (status === "merged") return "chip-greenlit";
  if (status === "ended") return "";
  if (status === "merge_failed") return "chip-trashed";
  return "";
}

interface Props {
  projectId: string;
}

export function SessionsList({ projectId }: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<SessionMode>("claude-code");

  const sessions = useQuery({
    queryKey: ["sessions.list", projectId],
    queryFn: () => trpc.sessions.list.query({ projectId }) as unknown as Promise<SessionRow[]>,
    enabled: projectId.length > 0,
    refetchInterval: 8_000,
  });

  const start = useMutation({
    mutationFn: () =>
      trpc.sessions.start.mutate({ projectId, mode }) as unknown as Promise<{ id: string }>,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["sessions.list", projectId] });
      nav(`/projects/${projectId}/sessions/${res.id}`);
    },
  });

  const rows = sessions.data ?? [];
  const hasRunning = rows.some((r) => r.status === "running");

  const ModePicker = (
    <div className="flex items-center gap-1 mono text-[10.5px] uppercase tracking-[0.18em]">
      {MODE_OPTIONS.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => setMode(m)}
          className={`px-2 py-0.5 border ${
            mode === m
              ? "border-[var(--color-accent)] text-[var(--color-fg-1)]"
              : "border-[var(--color-line)] text-[var(--color-fg-3)] hover:text-[var(--color-fg-1)]"
          }`}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );

  if (rows.length === 0 && !start.isPending) {
    // Render the "start" button as a single CTA so the section isn't empty.
    return (
      <section>
        <div className="flex items-center gap-2 px-1 mb-1.5">
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            ad-hoc sessions
          </span>
          <div className="hairline flex-1" />
          {ModePicker}
        </div>
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={start.isPending}
          className="btn btn-ghost text-[12px] w-full"
        >
          {start.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Terminal size={12} />
          )}
          start {MODE_LABELS[mode]} session
        </button>
        {start.isError ? (
          <div className="mt-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
            {(start.error as Error).message}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-1.5">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          ad-hoc sessions
        </span>
        <div className="hairline flex-1" />
        {!hasRunning ? ModePicker : null}
      </div>
      <div className="surface divide-y divide-[var(--color-line)]">
        {rows.map((s) => (
          <Link
            key={s.id}
            to={`/projects/${projectId}/sessions/${s.id}`}
            className="block px-3 py-2.5 hover:bg-[var(--color-bg-2)]"
          >
            <div className="flex items-center gap-2">
              <span className={`chip ${chipClass(s.status)}`}>{s.status}</span>
              <span className="mono text-[12px] truncate flex-1">
                {s.description || s.branchName.replace(/^factory\/adhoc-/, "")}
              </span>
              <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                {timeAgo(s.endedAt ?? s.startedAt)}
              </span>
            </div>
            <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate mt-0.5">
              {displayMode(s.mode)} · {s.commitCount} commit{s.commitCount === 1 ? "" : "s"}
            </div>
          </Link>
        ))}
      </div>
      <button
        type="button"
        onClick={() => start.mutate()}
        disabled={start.isPending || hasRunning}
        className="btn btn-ghost text-[12px] w-full mt-2"
        title={hasRunning ? "a session is already running for this project" : undefined}
      >
        {start.isPending ? <Loader2 size={12} className="animate-spin" /> : <Terminal size={12} />}
        {hasRunning ? "session already running" : `start ${MODE_LABELS[mode]} session`}
      </button>
      {start.isError ? (
        <div className="mt-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(start.error as Error).message}
        </div>
      ) : null}
    </section>
  );
}
