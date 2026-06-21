import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowRight,
  Cog,
  Folder,
  Inbox,
  Layers,
  LineChart,
  ListChecks,
  PenLine,
  Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";
import { usePalette } from "../lib/use-palette.ts";

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
}

interface TaskTemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string;
}

type ItemKind = "nav" | "project" | "template";

interface PaletteItem {
  kind: ItemKind;
  label: string;
  hint: string;
  href: string;
}

const NAV_ITEMS: PaletteItem[] = [
  { kind: "nav", label: "Inbox", hint: "/", href: "/" },
  { kind: "nav", label: "Capture idea", hint: "/inbox/new", href: "/inbox/new" },
  { kind: "nav", label: "Projects", hint: "/projects", href: "/projects" },
  { kind: "nav", label: "Open tasks", hint: "/tasks", href: "/tasks" },
  { kind: "nav", label: "History", hint: "/history", href: "/history" },
  { kind: "nav", label: "Metrics", hint: "/metrics", href: "/metrics" },
  {
    kind: "nav",
    label: "Task templates",
    hint: "/settings/task-templates",
    href: "/settings/task-templates",
  },
  { kind: "nav", label: "Settings", hint: "/settings", href: "/settings" },
];

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);
  const nav = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query() as unknown as Promise<ProjectRow[]>,
    staleTime: 30_000,
    enabled: open,
  });

  const templates = useQuery({
    queryKey: ["taskTemplates.list"],
    queryFn: () => trpc.taskTemplates.list.query() as unknown as Promise<TaskTemplateRow[]>,
    staleTime: 60_000,
    enabled: open,
  });

  // Reset query + selection on open; focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const items: PaletteItem[] = [
    ...NAV_ITEMS,
    ...(projects.data ?? []).map(
      (p): PaletteItem => ({
        kind: "project",
        label: p.name,
        hint: `project · ${p.slug}`,
        href: `/projects/${p.id}`,
      }),
    ),
    ...(templates.data ?? []).map(
      (t): PaletteItem => ({
        kind: "template",
        label: t.name,
        hint: t.description ? `template · ${t.description}` : `template · ${t.slug}`,
        href: `/settings/task-templates/${t.slug}`,
      }),
    ),
  ];
  const filtered = filterItems(items, query);

  // Keyboard navigation while the palette is open. Listed at the document
  // level because the input may have focus and arrow keys would otherwise
  // move the caret.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const item = filtered[selectedIndex];
        if (item) {
          e.preventDefault();
          nav(item.href);
          setOpen(false);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, filtered, selectedIndex, setOpen, nav]);

  // Keep the highlighted item in view when arrow-keying past the visible window.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Close only when the backdrop itself is clicked — clicks inside the
        // palette panel propagate up here too, so we filter by target identity.
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="command palette"
    >
      <div className="surface w-full max-w-[640px] mx-4 max-h-[60vh] flex flex-col shadow-xl">
        <div className="flex items-center gap-2 px-3 h-11 border-b border-[var(--color-line)]">
          <Search size={14} className="text-[var(--color-fg-3)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="search projects, templates, navigate…"
            className="flex-1 bg-transparent text-[14px] focus:outline-none placeholder:text-[var(--color-fg-3)]"
            autoCorrect="off"
            spellCheck={false}
          />
          <kbd className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] border border-[var(--color-line)] px-1.5 py-0.5 rounded-sm">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              no matches
            </div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={`${item.kind}:${item.href}`}
                type="button"
                data-idx={i}
                onClick={() => {
                  nav(item.href);
                  setOpen(false);
                }}
                onMouseEnter={() => setSelectedIndex(i)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 h-10 text-left",
                  i === selectedIndex
                    ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                    : "text-[var(--color-fg-1)]",
                )}
              >
                <ItemIcon kind={item.kind} label={item.label} />
                <span className="text-[13px] truncate flex-1">{item.label}</span>
                <span className="mono text-[10.5px] text-[var(--color-fg-3)] truncate max-w-[200px]">
                  {item.hint}
                </span>
                {i === selectedIndex ? (
                  <ArrowRight size={11} className="text-[var(--color-accent)] shrink-0" />
                ) : null}
              </button>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-3 h-8 border-t border-[var(--color-line)] mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="text-[var(--color-fg-2)]">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="text-[var(--color-fg-2)]">↵</kbd> select
            </span>
          </div>
          <span>
            {filtered.length} item{filtered.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}

function ItemIcon({ kind, label }: { kind: ItemKind; label: string }) {
  if (kind === "project") {
    return <Folder size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  }
  if (kind === "template") {
    return <Layers size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  }
  // Nav items get a subtly distinct icon per route.
  if (label === "Inbox") return <Inbox size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  if (label === "Capture idea")
    return <PenLine size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  if (label === "Projects")
    return <Folder size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  if (label === "Open tasks")
    return <ListChecks size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  if (label === "History")
    return <Archive size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  if (label === "Metrics")
    return <LineChart size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  if (label === "Task templates")
    return <Layers size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  if (label === "Settings") return <Cog size={13} className="text-[var(--color-fg-3)] shrink-0" />;
  return <Search size={13} className="text-[var(--color-fg-3)] shrink-0" />;
}

// Lower score = better match. Items with no signal (3) are filtered out.
function score(item: PaletteItem, q: string): number {
  const lbl = item.label.toLowerCase();
  if (lbl === q) return -1;
  if (lbl.startsWith(q)) return 0;
  if (lbl.includes(q)) return 1;
  if (item.hint.toLowerCase().includes(q)) return 2;
  return 3;
}

function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items;
  const q = query.toLowerCase().trim();
  return items
    .map((item) => ({ item, s: score(item, q) }))
    .filter(({ s }) => s < 3)
    .sort((a, b) => a.s - b.s)
    .map(({ item }) => item);
}
