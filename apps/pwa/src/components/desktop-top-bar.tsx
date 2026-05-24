import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { trpc } from "../lib/trpc.ts";
import { usePalette } from "../lib/use-palette.ts";
import { DashboardTicker } from "./dashboard-ticker.tsx";

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
}

export function DesktopTopBar() {
  return (
    <header className="hidden md:flex sticky top-0 z-20 h-12 items-center gap-4 px-6 border-b border-[var(--color-line)] bg-[var(--color-bg)]/95 backdrop-blur">
      <ProjectSwitcher />
      <span className="text-[var(--color-line)]">·</span>
      <Breadcrumb />
      <div className="ml-auto flex items-center gap-2">
        <DashboardTicker />
        <CommandPaletteTrigger />
      </div>
    </header>
  );
}

function ProjectSwitcher() {
  const loc = useLocation();
  const currentId = loc.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;

  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query() as unknown as Promise<ProjectRow[]>,
    staleTime: 30_000,
  });
  const current = currentId ? (projects.data ?? []).find((p) => p.id === currentId) : null;

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close the menu after the URL changes — clicking a project row triggers
  // navigation that completes before the menu naturally closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-8 px-2 -ml-2 hover:bg-[var(--color-bg-2)] rounded-sm text-[13px] text-[var(--color-fg-1)]"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? (
          <span className="display truncate max-w-[200px]">{current.name}</span>
        ) : (
          <span className="mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            select project
          </span>
        )}
        <ChevronDown size={12} className="text-[var(--color-fg-3)] shrink-0" />
      </button>

      {open ? (
        <div
          className="absolute top-full left-0 mt-1 surface min-w-[280px] max-h-[60vh] overflow-y-auto py-1 z-30 shadow-lg"
          role="listbox"
        >
          {projects.isLoading ? (
            <div className="px-3 py-2 text-[12px] text-[var(--color-fg-3)]">loading…</div>
          ) : (projects.data ?? []).length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[var(--color-fg-3)]">no projects yet</div>
          ) : (
            <>
              <Link
                to="/projects"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 h-9 mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg-1)] border-b border-[var(--color-line)]"
              >
                all projects
              </Link>
              {(projects.data ?? []).map((p) => (
                <Link
                  key={p.id}
                  to={`/projects/${p.id}`}
                  className={cn(
                    "flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-[var(--color-bg-2)]",
                    p.id === currentId
                      ? "text-[var(--color-fg)] bg-[var(--color-bg-2)]/60"
                      : "text-[var(--color-fg-1)]",
                  )}
                  role="option"
                  aria-selected={p.id === currentId}
                >
                  <span className="truncate flex-1">{p.name}</span>
                  <span className="mono text-[10.5px] text-[var(--color-fg-3)] shrink-0">
                    {p.slug}
                  </span>
                </Link>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface Crumb {
  label: string;
  href?: string;
}

function Breadcrumb() {
  const loc = useLocation();
  const projects = useQuery({
    queryKey: ["projects.list"],
    queryFn: () => trpc.projects.list.query() as unknown as Promise<ProjectRow[]>,
    staleTime: 30_000,
  });
  const crumbs = parseBreadcrumb(loc.pathname, projects.data ?? []);

  return (
    <nav
      className="flex items-center gap-1.5 mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] truncate min-w-0"
      aria-label="breadcrumb"
    >
      {crumbs.map((c, i) => (
        <span key={`${c.label}-${c.href ?? "leaf"}`} className="flex items-center gap-1.5 min-w-0">
          {i > 0 ? <ChevronRight size={11} className="shrink-0" /> : null}
          {c.href ? (
            <Link to={c.href} className="hover:text-[var(--color-fg-1)] truncate max-w-[180px]">
              {c.label}
            </Link>
          ) : (
            <span
              className={cn(
                "truncate max-w-[180px]",
                i === crumbs.length - 1 ? "text-[var(--color-fg-1)]" : "",
              )}
            >
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

function parseBreadcrumb(pathname: string, projects: ProjectRow[]): Crumb[] {
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  if (pathname === "/") return [{ label: "inbox" }];
  if (pathname === "/inbox/new") return [{ label: "inbox", href: "/" }, { label: "capture" }];
  if (pathname === "/inbox/import-spec") {
    return [{ label: "inbox", href: "/" }, { label: "import spec" }];
  }
  if (pathname.startsWith("/decisions/")) {
    return [{ label: "inbox", href: "/" }, { label: "decision" }];
  }
  if (pathname.startsWith("/plans/")) return [{ label: "plan" }];
  if (pathname.startsWith("/feedback/")) {
    return [{ label: "inbox", href: "/" }, { label: "feedback" }];
  }

  if (pathname === "/projects") return [{ label: "projects" }];
  if (pathname === "/projects/import") {
    return [{ label: "projects", href: "/projects" }, { label: "import" }];
  }

  const projMatch = pathname.match(/^\/projects\/([^/]+)(?:\/(.+))?$/);
  if (projMatch) {
    const [, id, rest] = projMatch;
    if (!id) return [{ label: "projects", href: "/projects" }];
    const projCrumb: Crumb = { label: projectName(id), href: `/projects/${id}` };
    const base: Crumb[] = [{ label: "projects", href: "/projects" }, projCrumb];
    if (!rest) return base;
    if (rest.startsWith("tasks/")) return [...base, { label: "task" }];
    if (rest.startsWith("runs/")) return [...base, { label: "run" }];
    if (rest.startsWith("sessions/")) return [...base, { label: "session" }];
    if (rest.startsWith("scripts/")) return [...base, { label: "script" }];
    if (rest.startsWith("audits/")) return [...base, { label: "audit" }];
    if (rest === "deepen") return [...base, { label: "deepen" }];
    if (rest === "code") return [...base, { label: "code" }];
    return [...base, { label: rest }];
  }

  if (pathname === "/settings") return [{ label: "settings" }];
  if (pathname.startsWith("/settings/")) {
    const sub = pathname.slice("/settings/".length).split("/")[0] ?? "";
    return [{ label: "settings", href: "/settings" }, { label: sub }];
  }

  if (pathname === "/metrics") return [{ label: "metrics" }];

  return [{ label: pathname }];
}

function CommandPaletteTrigger() {
  const setOpen = usePalette((s) => s.setOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex items-center gap-2 px-2.5 h-7 surface border border-[var(--color-line)] hover:border-[var(--color-line-bright)] hover:text-[var(--color-fg-1)] text-[var(--color-fg-3)]"
      aria-label="open command palette"
    >
      <Search size={12} />
      <span className="mono text-[10.5px] uppercase tracking-[0.18em]">search</span>
      <span className="mono text-[10.5px] text-[var(--color-fg-3)] ml-2">⌘K</span>
    </button>
  );
}
