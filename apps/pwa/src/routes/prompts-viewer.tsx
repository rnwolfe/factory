import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";

export function PromptsViewer() {
  const list = useQuery({
    queryKey: ["prompts.list"],
    queryFn: () => trpc.prompts.list.query(),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link to="/settings" className="btn btn-ghost h-8 px-2" aria-label="back to settings">
          <ArrowLeft size={14} />
        </Link>
        <span className="display text-lg text-[var(--color-fg)]">prompts</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          · active
        </span>
      </div>

      <p className="px-1 text-[12px] text-[var(--color-fg-2)] leading-relaxed">
        these are the active prompts seeded into the daemon db. read-only — edits land via{" "}
        <span className="mono text-[var(--color-fg-1)]">prompts/*.md</span> +{" "}
        <span className="mono text-[var(--color-fg-1)]">bun run seed</span>.
      </p>

      {list.isLoading ? (
        <div className="surface p-3">
          <div className="skel h-4 w-1/2 mb-2" />
          <div className="skel h-3 w-3/4" />
        </div>
      ) : list.isError ? (
        <div className="surface p-3 text-[13px] text-[var(--color-verdict-trashed)]">
          failed to load prompts.
        </div>
      ) : list.data && list.data.length > 0 ? (
        <div className="space-y-2">
          {list.data.map((p) => (
            <PromptCard key={p.id} promptKey={p.promptKey} version={p.version} />
          ))}
        </div>
      ) : (
        <div className="surface p-3 text-[13px] text-[var(--color-fg-3)]">no active prompts.</div>
      )}
    </div>
  );
}

function PromptCard({ promptKey, version }: { promptKey: string; version: number }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["prompts.get", promptKey, version],
    queryFn: () => trpc.prompts.get.query({ key: promptKey, version }),
    enabled: open,
  });

  return (
    <div className="surface">
      <button
        type="button"
        className="w-full px-3 h-11 flex items-center justify-between gap-3"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown size={14} className="text-[var(--color-fg-3)]" />
          ) : (
            <ChevronRight size={14} className="text-[var(--color-fg-3)]" />
          )}
          <span className="mono text-[12.5px] text-[var(--color-fg-1)] truncate">{promptKey}</span>
        </div>
        <span className="mono text-[11px] text-[var(--color-fg-3)] flex-shrink-0">v{version}</span>
      </button>
      {open ? (
        <div className="border-t border-[var(--color-line)] p-3">
          {detail.isLoading ? (
            <div className="skel h-3 w-full" />
          ) : detail.data ? (
            <pre className="mono text-[11.5px] leading-relaxed text-[var(--color-fg-1)] whitespace-pre-wrap break-words">
              {detail.data.content}
            </pre>
          ) : (
            <span className="mono text-[11px] text-[var(--color-fg-3)]">no content</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
