import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Play, Square } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface PackageScript {
  scriptName: string;
  command: string;
}

interface RunningScript {
  id: string;
  projectId: string;
  scriptName: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: "running" | "exited" | "killed" | "failed";
  urls: string[];
  tail: string;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

interface Props {
  projectId: string;
}

export function ScriptsSection({ projectId }: Props) {
  const nav = useNavigate();
  const qc = useQueryClient();

  const available = useQuery({
    queryKey: ["scripts.listAvailable", projectId],
    queryFn: () =>
      trpc.scripts.listAvailable.query({ projectId }) as unknown as Promise<PackageScript[]>,
    enabled: projectId.length > 0,
  });

  const active = useQuery({
    queryKey: ["scripts.active", projectId],
    queryFn: () => trpc.scripts.active.query({ projectId }) as unknown as Promise<RunningScript[]>,
    enabled: projectId.length > 0,
    refetchInterval: 4_000,
  });

  const start = useMutation({
    mutationFn: (scriptName: string) =>
      trpc.scripts.start.mutate({ projectId, scriptName }) as unknown as Promise<{
        handle: RunningScript;
      }>,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["scripts.active", projectId] });
      nav(`/projects/${projectId}/scripts/${res.handle.id}`);
    },
  });

  const stop = useMutation({
    mutationFn: (id: string) => trpc.scripts.stop.mutate({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scripts.active", projectId] });
    },
  });

  const scripts = available.data ?? [];
  const running = (active.data ?? []).filter((s) => s.status === "running");
  // Map scriptName -> running handle so we can show "running" inline.
  const runningByName = new Map<string, RunningScript>();
  for (const r of running) runningByName.set(r.scriptName, r);

  if (scripts.length === 0 && running.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 px-1 mb-1.5">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          scripts
        </span>
        <div className="hairline flex-1" />
        {scripts.length > 0 ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
            {scripts.length} in package.json
          </span>
        ) : null}
      </div>

      {scripts.length > 0 ? (
        <div className="surface divide-y divide-[var(--color-line)]">
          {scripts.map((s) => {
            const r = runningByName.get(s.scriptName);
            return (
              <div key={s.scriptName} className="flex items-stretch">
                <Link
                  to={r ? `/projects/${projectId}/scripts/${r.id}` : "#"}
                  className={`flex-1 min-w-0 px-3 py-2.5 ${
                    r ? "hover:bg-[var(--color-bg-2)]" : "cursor-default"
                  }`}
                  onClick={(e) => {
                    if (!r) e.preventDefault();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] truncate">{s.scriptName}</span>
                    {r ? <span className="chip status-in_progress">running</span> : null}
                  </div>
                  <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate">
                    {s.command}
                  </div>
                  {r && r.urls.length > 0 ? (
                    <div className="mono text-[10.5px] text-[var(--color-accent)] truncate mt-0.5">
                      {r.urls.slice(0, 2).join(" · ")}
                    </div>
                  ) : null}
                </Link>
                <div className="flex items-center px-2 border-l border-[var(--color-line)] gap-1">
                  {r ? (
                    <button
                      type="button"
                      onClick={() => stop.mutate(r.id)}
                      disabled={stop.isPending}
                      className="btn btn-ghost text-[11px] !h-8 !px-2"
                      aria-label={`stop ${s.scriptName}`}
                    >
                      {stop.isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Square size={12} />
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => start.mutate(s.scriptName)}
                      disabled={start.isPending}
                      className="btn btn-ghost text-[11px] !h-8 !px-2"
                      aria-label={`run ${s.scriptName}`}
                    >
                      {start.isPending && start.variables === s.scriptName ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Play size={12} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {start.isError ? (
        <div className="mt-2 mono text-[11px] text-[var(--color-verdict-trashed)]">
          {(start.error as Error).message}
        </div>
      ) : null}

      {/* Recently-exited handles surface here so the operator can revisit logs/URLs. */}
      {(active.data ?? []).filter((s) => s.status !== "running").length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            recent runs ({(active.data ?? []).filter((s) => s.status !== "running").length})
          </summary>
          <ul className="surface divide-y divide-[var(--color-line)] mt-2">
            {(active.data ?? [])
              .filter((s) => s.status !== "running")
              .slice(0, 8)
              .map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/projects/${projectId}/scripts/${s.id}`}
                    className="block px-3 py-2 hover:bg-[var(--color-bg-2)]"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`chip ${
                          s.status === "exited" && s.exitCode === 0
                            ? "chip-greenlit"
                            : "chip-trashed"
                        }`}
                      >
                        {s.status}
                        {s.exitCode != null ? ` ${s.exitCode}` : ""}
                      </span>
                      <span className="text-[13px] truncate flex-1">{s.scriptName}</span>
                      <span className="mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                        {timeAgo(s.endedAt ?? s.startedAt)}
                      </span>
                    </div>
                    {s.urls.length > 0 ? (
                      <div className="mono text-[10.5px] text-[var(--color-fg-3)] truncate mt-0.5">
                        <ExternalLink size={9} className="inline mr-1" />
                        {s.urls.slice(0, 2).join(" · ")}
                      </div>
                    ) : null}
                  </Link>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
