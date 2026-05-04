import { Cog, Inbox as InboxIcon, Layers, PenLine } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "../lib/cn.ts";

const NAV: Array<{ to: string; label: string; icon: typeof InboxIcon }> = [
  { to: "/", label: "inbox", icon: InboxIcon },
  { to: "/inbox/new", label: "capture", icon: PenLine },
  { to: "/projects", label: "projects", icon: Layers },
  { to: "/settings", label: "settings", icon: Cog },
];

export function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const titleByRoute: Record<string, string> = {
    "/": "decisions",
    "/inbox/new": "capture",
    "/projects": "projects",
    "/settings": "settings",
  };
  const title = titleByRoute[loc.pathname] ?? "factory";

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-bg)]/95 backdrop-blur"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex items-center justify-between px-4 h-12">
          <div className="flex items-baseline gap-3">
            <span className="display text-lg leading-none text-[var(--color-fg)]">factory</span>
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              · {title}
            </span>
          </div>
          <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
            v0.2
          </span>
        </div>
      </header>

      <main
        className="flex-1 px-3 pt-3 pb-[88px]"
        style={{ paddingBottom: "calc(72px + env(safe-area-inset-bottom))" }}
      >
        {children}
      </main>

      <nav
        className="fixed bottom-0 inset-x-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-bg-1)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid grid-cols-4 h-14">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center justify-center gap-1 text-[10.5px] uppercase tracking-[0.18em]",
                  isActive
                    ? "text-[var(--color-accent)]"
                    : "text-[var(--color-fg-2)] active:bg-[var(--color-bg-2)]",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon size={18} strokeWidth={isActive ? 2.2 : 1.6} />
                  <span className="mono">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
