import { useQuery } from "@tanstack/react-query";
import { BookMarked, ChevronRight } from "lucide-react";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

export type MemoryFactType = "user" | "feedback" | "project" | "reference";

export interface MemoryFact {
  file: string;
  name: string;
  description: string;
  type: MemoryFactType;
  body: string;
  provenance?: string[];
}

export interface MemoryData {
  repoPath: string;
  facts: MemoryFact[];
}

// Stable section order + human labels. Sections render only when populated.
const SECTIONS: { type: MemoryFactType; label: string }[] = [
  { type: "user", label: "user" },
  { type: "feedback", label: "feedback" },
  { type: "project", label: "project" },
  { type: "reference", label: "reference" },
];

export function Memory() {
  const q = useQuery({
    queryKey: ["memory.list"],
    queryFn: () => trpc.memory.list.query() as unknown as Promise<MemoryData>,
  });

  return (
    <div className="space-y-4 pb-4">
      <header className="surface p-4">
        <div className="flex items-center gap-2">
          <BookMarked size={14} className="text-[var(--color-accent)]" />
          <h1 className="display text-[20px] leading-none">operator memory</h1>
        </div>
        <p className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mt-2">
          conventions · preferences · patterns
        </p>
      </header>

      {q.isLoading ? (
        <div className="surface p-4">
          <div className="skel h-6 w-40 mb-3" />
          <div className="skel h-32 w-full" />
        </div>
      ) : (
        <MemoryView data={q.data} />
      )}
    </div>
  );
}

/**
 * Pure view over the operator-memory store. Split from the fetching wrapper so
 * it renders deterministically under test (empty + populated) without mocking
 * tRPC — same pattern as WatchPanelView.
 */
export function MemoryView({ data }: { data: MemoryData | undefined }) {
  if (!data) {
    return (
      <div className="surface p-4 text-sm text-[var(--color-fg-2)]">
        couldn't load operator memory.
      </div>
    );
  }

  const { repoPath, facts } = data;

  return (
    <>
      {facts.length === 0 ? (
        <div className="surface p-5 text-center">
          <p className="text-[14px] text-[var(--color-fg-1)]">Operator memory is empty.</p>
          <p className="text-[13px] text-[var(--color-fg-3)] mt-2 max-w-[44ch] mx-auto">
            Conventions you record from The Watch's insights (record-as-convention) land here — a
            Factory-earned memory of how you work.
          </p>
        </div>
      ) : (
        SECTIONS.map(({ type, label }) => {
          const group = facts.filter((f) => f.type === type);
          if (group.length === 0) return null;
          return (
            <section key={type}>
              <SectionHeader title={label} count={group.length} />
              <div className="surface divide-y divide-[var(--color-line)]">
                {group.map((f) => (
                  <FactRow key={f.file} fact={f} />
                ))}
              </div>
            </section>
          );
        })
      )}

      <RepoPath path={repoPath} />
    </>
  );
}

function FactRow({ fact }: { fact: MemoryFact }) {
  const [open, setOpen] = useState(false);
  const provenance = fact.provenance ?? [];
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--color-bg-2)]"
      >
        <ChevronRight
          size={13}
          className={`mt-0.5 shrink-0 text-[var(--color-fg-3)] transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="mono text-[12.5px] text-[var(--color-fg)] truncate">{fact.name}</div>
          <div className="text-[13px] text-[var(--color-fg-2)] mt-0.5">{fact.description}</div>
        </div>
      </button>
      {open ? (
        <div className="px-3 pb-3 pl-[2.4rem] space-y-2.5">
          <pre className="whitespace-pre-wrap break-words mono text-[11.5px] leading-relaxed text-[var(--color-fg-1)] bg-[var(--color-bg)] border border-[var(--color-line)] rounded-sm p-2.5">
            {fact.body}
          </pre>
          {provenance.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {provenance.map((p) => (
                <span key={p} className="chip mono text-[10.5px]">
                  {p}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RepoPath({ path }: { path: string }) {
  return <p className="mono text-[10.5px] text-[var(--color-fg-3)] px-1 truncate">repo · {path}</p>;
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-1 mb-1.5">
      <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
        {title}
      </span>
      <div className="hairline flex-1" />
      {count != null ? (
        <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{count}</span>
      ) : null}
    </div>
  );
}
