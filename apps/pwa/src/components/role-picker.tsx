import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc.ts";

const ROLES = ["owner", "contributor"] as const;
export type ProjectRole = (typeof ROLES)[number];

interface Props {
  projectId: string;
  role: ProjectRole;
  onChanged?: (role: ProjectRole) => void;
}

export function RolePicker({ projectId, role, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const setRole = useMutation({
    mutationFn: (next: ProjectRole) => trpc.projects.setRole.mutate({ id: projectId, role: next }),
    onSuccess: (_data, next) => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      onChanged?.(next);
    },
  });

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (target && wrapRef.current && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("touchstart", onDocDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("touchstart", onDocDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className={`relative inline-block ${open ? "z-50" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={setRole.isPending}
        className="chip flex items-center gap-1 text-[11px]"
      >
        {role}
        <ChevronDown size={11} />
      </button>
      {open ? (
        <ul className="absolute left-0 mt-1 z-50 surface min-w-[140px] py-1 text-[12.5px] shadow-lg">
          {ROLES.map((r) => (
            <li key={r}>
              <button
                type="button"
                onClick={() => setRole.mutate(r)}
                className={`w-full text-left px-3 py-1.5 hover:bg-[var(--color-bg-2)] ${
                  r === role ? "text-[var(--color-accent)]" : "text-[var(--color-fg-1)]"
                }`}
              >
                {r}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
