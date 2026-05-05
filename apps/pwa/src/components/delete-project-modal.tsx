import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

interface Props {
  projectId: string;
  onClose: () => void;
  onDeleted: () => void;
}

interface Preview {
  workdirPath: string;
  workdirInsideFactoryRoot: boolean;
  worktreeCount: number;
  worktreeSlugDir: string | null;
  approvedReportPaths: string[];
}

export function DeleteProjectModal({ projectId, onClose, onDeleted }: Props) {
  const [slugConfirm, setSlugConfirm] = useState("");
  const [removeWorkdir, setRemoveWorkdir] = useState(true);

  const project = useQuery({
    queryKey: ["projects.get", projectId],
    queryFn: () => trpc.projects.get.query({ id: projectId }),
    enabled: projectId.length > 0,
  });

  const preview = useQuery({
    queryKey: ["projects.previewDelete", projectId],
    queryFn: () =>
      trpc.projects.previewDelete.query({ id: projectId }) as unknown as Promise<Preview>,
    enabled: projectId.length > 0,
  });

  const remove = useMutation({
    mutationFn: () =>
      trpc.projects.delete.mutate({
        id: projectId,
        slugConfirm,
        removeWorkdir,
      }),
    onSuccess: onDeleted,
  });

  const slug = project.data?.project.slug ?? "";
  const canDelete = slug.length > 0 && slugConfirm === slug && !remove.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
      role="dialog"
      aria-modal="true"
    >
      <div className="surface w-full max-w-md max-h-[90vh] overflow-y-auto p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-[var(--color-verdict-trashed)]" />
            <span className="display text-lg">delete project</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost h-8 px-2"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>

        {project.data ? (
          <p className="text-[13px] text-[var(--color-fg-2)]">
            destructive: removes <span className="mono">{slug}</span> and its DB rows. type the slug
            to confirm.
          </p>
        ) : null}

        {preview.data ? (
          <div className="surface p-3 mono text-[11.5px] text-[var(--color-fg-2)] space-y-0.5">
            <div>workdir: {preview.data.workdirPath}</div>
            <div>worktrees: {preview.data.worktreeCount}</div>
            {preview.data.approvedReportPaths.length > 0 ? (
              <div>approved audit reports: {preview.data.approvedReportPaths.length}</div>
            ) : null}
            {!preview.data.workdirInsideFactoryRoot ? (
              <div className="text-[var(--color-fg-3)]">
                · imported workdir — repo files will be left in place
              </div>
            ) : null}
          </div>
        ) : null}

        <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-fg-2)] cursor-pointer">
          <input
            type="checkbox"
            checked={removeWorkdir}
            onChange={(e) => setRemoveWorkdir(e.target.checked)}
            disabled={preview.data && !preview.data.workdirInsideFactoryRoot}
          />
          <span>
            also remove workdir on disk
            {preview.data && !preview.data.workdirInsideFactoryRoot ? " (n/a — imported)" : ""}
          </span>
        </label>

        <div>
          <label
            htmlFor="slug-confirm"
            className="block mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-1"
          >
            type "{slug}" to confirm
          </label>
          <input
            id="slug-confirm"
            type="text"
            value={slugConfirm}
            onChange={(e) => setSlugConfirm(e.target.value)}
            placeholder={slug}
            className="surface w-full h-9 px-2 mono text-[12px] bg-transparent border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {remove.isError ? (
          <div className="text-[12px] text-[var(--color-verdict-trashed)]">
            {(remove.error as Error).message}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost text-[12px]">
            cancel
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={!canDelete}
            className="btn btn-danger text-[12px]"
          >
            {remove.isPending ? (
              <>
                <Loader2 size={12} className="animate-spin" /> deleting…
              </>
            ) : (
              "delete project"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
