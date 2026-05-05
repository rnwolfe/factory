import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, MoreVertical, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";
import { DeleteProjectModal } from "./delete-project-modal.tsx";

interface Props {
  projectId: string;
  archived: boolean;
}

export function ProjectOverflowMenu({ projectId, archived }: Props) {
  const [open, setOpen] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const qc = useQueryClient();
  const nav = useNavigate();

  const archive = useMutation({
    mutationFn: () => trpc.projects.archive.mutate({ id: projectId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      setOpen(false);
    },
  });

  const unarchive = useMutation({
    mutationFn: () => trpc.projects.unarchive.mutate({ id: projectId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      setOpen(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <>
      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn btn-ghost h-8 px-2"
          aria-label="project actions"
        >
          <MoreVertical size={14} />
        </button>
        {open ? (
          <div className="absolute right-0 mt-1 z-20 surface border border-[var(--color-line)] min-w-[180px] py-1 shadow-lg">
            {archived ? (
              <button
                type="button"
                onClick={() => unarchive.mutate()}
                disabled={unarchive.isPending}
                className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-[var(--color-bg-2)]"
              >
                <ArchiveRestore size={13} /> unarchive
              </button>
            ) : (
              <button
                type="button"
                onClick={() => archive.mutate()}
                disabled={archive.isPending}
                className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-[var(--color-bg-2)]"
              >
                <Archive size={13} /> archive
              </button>
            )}
            <div className="hairline mx-2 my-1" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setShowDelete(true);
              }}
              className="w-full flex items-center gap-2 px-3 h-9 text-[13px] text-[var(--color-verdict-trashed)] hover:bg-[var(--color-bg-2)]"
            >
              <Trash2 size={13} /> delete…
            </button>
          </div>
        ) : null}
      </div>
      {showDelete ? (
        <DeleteProjectModal
          projectId={projectId}
          onClose={() => setShowDelete(false)}
          onDeleted={() => {
            setShowDelete(false);
            qc.invalidateQueries({ queryKey: ["projects.list"] });
            nav("/projects");
          }}
        />
      ) : null}
    </>
  );
}
