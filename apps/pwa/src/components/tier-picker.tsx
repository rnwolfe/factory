import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

const TIERS = ["tinker", "personal", "share", "productize"] as const;
export type Tier = (typeof TIERS)[number];

interface Props {
  projectId: string;
  tier: Tier;
  onChanged?: (tier: Tier) => void;
}

export function TierPicker({ projectId, tier, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const setTier = useMutation({
    mutationFn: (next: Tier) => trpc.projects.setTier.mutate({ id: projectId, tier: next }),
    onSuccess: (_data, next) => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["projects.get", projectId] });
      qc.invalidateQueries({ queryKey: ["projects.list"] });
      onChanged?.(next);
    },
  });

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={setTier.isPending}
        className="chip flex items-center gap-1 text-[11px]"
      >
        {tier}
        <ChevronDown size={11} />
      </button>
      {open ? (
        <ul className="absolute left-0 mt-1 z-20 surface min-w-[140px] py-1 text-[12.5px] shadow-lg">
          {TIERS.map((t) => (
            <li key={t}>
              <button
                type="button"
                onClick={() => setTier.mutate(t)}
                className={`w-full text-left px-3 py-1.5 hover:bg-[var(--color-bg-2)] ${
                  t === tier ? "text-[var(--color-accent)]" : "text-[var(--color-fg-1)]"
                }`}
              >
                {t}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
