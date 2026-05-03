import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

const TAGS = ["active", "background", "past"] as const;
export type Tag = (typeof TAGS)[number];

export function TagChip({ projectId, tag }: { projectId: string; tag: Tag }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const setTag = useMutation({
    mutationFn: (vars: { tag: Tag }) => trpc.projects.tag.mutate({ id: projectId, tag: vars.tag }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["projects.get", projectId] });
      const prev = qc.getQueryData<{ project: { tag: Tag } }>(["projects.get", projectId]);
      qc.setQueryData(["projects.get", projectId], (data: unknown) => {
        if (!data || typeof data !== "object" || !("project" in data)) return data;
        const d = data as { project: { tag: Tag } };
        return { ...d, project: { ...d.project, tag: vars.tag } };
      });
      // Also bump the projects list so the tag group changes.
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["projects.get", projectId], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
    },
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`chip ${tag === "active" ? "chip-accent" : ""} hover:border-[var(--color-line-bright)]`}
      >
        {tag}
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10"
          />
          <div className="absolute right-0 mt-1 surface-2 shadow-[var(--shadow-elev)] z-20 min-w-[140px]">
            {TAGS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTag.mutate({ tag: t });
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-[13px] hover:bg-[var(--color-bg-3)] ${
                  t === tag ? "text-[var(--color-accent)]" : "text-[var(--color-fg-1)]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
