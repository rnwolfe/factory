import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

interface WorktreeRow {
  path: string;
  projectSlug: string;
  runId: string;
  branch: string | null;
  sizeBytes: number;
  mtime: number;
  orphaned: boolean;
  active: boolean;
  projectId: string | null;
  runStatus: string | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtAge(ms: number): string {
  const diff = Date.now() - ms;
  const d = Math.floor(diff / 86_400_000);
  if (d > 0) return `${d}d`;
  const h = Math.floor(diff / 3_600_000);
  if (h > 0) return `${h}h`;
  const m = Math.floor(diff / 60_000);
  return `${m}m`;
}

export function WorktreesAdmin() {
  const list = useQuery({
    queryKey: ["worktrees.list"],
    queryFn: () => trpc.worktrees.list.query() as unknown as Promise<WorktreeRow[]>,
    refetchInterval: 30_000,
  });
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<WorktreeRow | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (input: { path: string }) =>
      trpc.worktrees.delete.mutate(input) as unknown as Promise<{ ok: boolean }>,
    onSuccess: () => {
      setPendingDelete(null);
      setErrorMsg(null);
      qc.invalidateQueries({ queryKey: ["worktrees.list"] });
    },
    onError: (err: unknown) => {
      setErrorMsg(err instanceof Error ? err.message : "delete failed");
    },
  });

  const rows = list.data ?? [];
  const totalBytes = rows.reduce((acc, r) => acc + r.sizeBytes, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link to="/settings" className="btn btn-ghost h-8 px-2" aria-label="back to settings">
          <ArrowLeft size={14} />
        </Link>
        <span className="display text-lg text-[var(--color-fg)]">worktrees</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          · disk
        </span>
      </div>

      <p className="px-1 text-[12px] text-[var(--color-fg-2)] leading-relaxed">
        per-run worktrees living under <span className="mono">~/.factory/worktrees/</span>. Active
        runs cannot be deleted; orphaned worktrees (run row gone) are safe to reclaim.
      </p>

      <div className="surface px-3 py-2 flex items-center justify-between">
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          total
        </span>
        <span className="mono text-[12.5px] tabular-nums text-[var(--color-fg-1)]">
          {rows.length} worktree{rows.length === 1 ? "" : "s"} · {fmtBytes(totalBytes)}
        </span>
      </div>

      {list.isLoading ? (
        <div className="surface p-3">
          <div className="skel h-4 w-1/2 mb-2" />
          <div className="skel h-3 w-3/4" />
        </div>
      ) : list.isError ? (
        <div className="surface p-3 text-[13px] text-[var(--color-verdict-trashed)]">
          failed to load worktrees.
        </div>
      ) : rows.length === 0 ? (
        <div className="surface p-3 text-[13px] text-[var(--color-fg-3)]">
          no worktrees on disk.
        </div>
      ) : (
        <ul className="surface divide-y divide-[var(--color-line)]">
          {rows.map((r) => (
            <li key={r.path} className="px-3 py-2.5 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="mono text-[12.5px] text-[var(--color-fg-1)] truncate">
                    {r.projectSlug}/{r.runId.slice(0, 8)}
                  </span>
                  {r.active ? <span className="chip chip-accent">active</span> : null}
                  {r.orphaned ? <span className="chip chip-trashed">orphaned</span> : null}
                  {r.runStatus && !r.active ? <span className="chip">{r.runStatus}</span> : null}
                </div>
                <div className="mt-1 flex items-center gap-2 mono text-[10.5px] text-[var(--color-fg-3)] tabular-nums">
                  {r.branch ? <span>{r.branch}</span> : <span>(detached)</span>}
                  <span>·</span>
                  <span>{fmtBytes(r.sizeBytes)}</span>
                  <span>·</span>
                  <span>{fmtAge(r.mtime)} ago</span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost h-8 px-2 text-[var(--color-verdict-trashed)] disabled:opacity-30"
                disabled={r.active}
                onClick={() => {
                  setErrorMsg(null);
                  setPendingDelete(r);
                }}
                aria-label={`delete ${r.runId}`}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete ? (
        <ConfirmModal
          row={pendingDelete}
          busy={remove.isPending}
          errorMsg={errorMsg}
          onCancel={() => {
            setPendingDelete(null);
            setErrorMsg(null);
          }}
          onConfirm={() => remove.mutate({ path: pendingDelete.path })}
        />
      ) : null}
    </div>
  );
}

function ConfirmModal({
  row,
  busy,
  errorMsg,
  onCancel,
  onConfirm,
}: {
  row: WorktreeRow;
  busy: boolean;
  errorMsg: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 px-3">
      <div className="surface w-full max-w-md p-4 space-y-3" role="dialog" aria-modal="true">
        <div className="display text-[16px] text-[var(--color-fg)]">delete worktree?</div>
        <div className="mono text-[11.5px] text-[var(--color-fg-2)] break-all">{row.path}</div>
        <p className="text-[12.5px] text-[var(--color-fg-2)] leading-relaxed">
          Removes the directory and the <span className="mono">git worktree</span> pointer in the
          parent project repo. Cannot be undone, but the run row (if any) and the underlying branch
          are not touched.
        </p>
        {errorMsg ? (
          <div className="mono text-[11.5px] text-[var(--color-verdict-trashed)] border border-[var(--color-verdict-trashed)] bg-[var(--color-verdict-trashed-soft)] px-2 py-1.5 rounded-[2px]">
            {errorMsg}
          </div>
        ) : null}
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "deleting…" : "delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
