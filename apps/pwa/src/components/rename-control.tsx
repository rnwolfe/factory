import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc.ts";

interface Props {
  projectId: string;
  name: string;
}

/**
 * Inline project rename in the header (ADR-021 companion). Renders the name as
 * the page title with a pencil affordance; editing swaps to a text field that
 * commits on Enter / ✓ and reverts on Esc / ✕. The daemon slugifies the name and
 * moves the on-disk dir; the route is keyed by project id, so no navigation is
 * needed — just refetch.
 */
export function RenameControl({ projectId, name }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const rename = useMutation({
    mutationFn: (next: string) => trpc.projects.rename.mutate({ id: projectId, name: next }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
    },
  });

  useEffect(() => {
    if (editing) {
      setDraft(name);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, name]);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === name) {
      setEditing(false);
      return;
    }
    rename.mutate(next);
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="display text-[22px] leading-tight text-[var(--color-fg)] truncate">
          {name}
        </h1>
        <button
          type="button"
          aria-label="rename project"
          onClick={() => setEditing(true)}
          className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)] shrink-0"
        >
          <Pencil size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          disabled={rename.isPending}
          className="display text-[20px] leading-tight bg-[var(--color-bg-2)] border border-[var(--color-line)] rounded px-2 py-0.5 min-w-0 flex-1 text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="button"
          aria-label="save"
          onClick={commit}
          disabled={rename.isPending}
          className="text-[var(--color-working)] hover:opacity-80 shrink-0"
        >
          <Check size={16} />
        </button>
        <button
          type="button"
          aria-label="cancel"
          onClick={() => setEditing(false)}
          disabled={rename.isPending}
          className="text-[var(--color-fg-3)] hover:text-[var(--color-fg)] shrink-0"
        >
          <X size={16} />
        </button>
      </div>
      {rename.isError ? (
        <div className="mt-1 text-[11px] text-[var(--color-verdict-trashed)]">
          {(rename.error as Error).message}
        </div>
      ) : null}
    </div>
  );
}
