import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

const CEREMONIES = ["tinker", "personal", "shared", "production"] as const;
export type Ceremony = (typeof CEREMONIES)[number];

interface Props {
  projectId: string;
  ceremony: Ceremony;
  onChanged?: (ceremony: Ceremony) => void;
}

export function CeremonyPicker({ projectId, ceremony, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const setCeremony = useMutation({
    mutationFn: (next: Ceremony) =>
      trpc.projects.setCeremony.mutate({ id: projectId, ceremony: next }),
    onSuccess: (_data, next) => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      onChanged?.(next);
    },
  });

  return (
    <div className={`relative inline-block ${open ? "z-50" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={setCeremony.isPending}
        className="chip flex items-center gap-1 text-[11px]"
      >
        {ceremony}
        <ChevronDown size={11} />
      </button>
      {open ? (
        <ul className="absolute left-0 mt-1 z-50 surface min-w-[140px] py-1 text-[12.5px] shadow-lg">
          {CEREMONIES.map((c) => (
            <li key={c}>
              <button
                type="button"
                onClick={() => setCeremony.mutate(c)}
                className={`w-full text-left px-3 py-1.5 hover:bg-[var(--color-bg-2)] ${
                  c === ceremony ? "text-[var(--color-accent)]" : "text-[var(--color-fg-1)]"
                }`}
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
