import { Cog, Inbox as InboxIcon, Layers, PenLine } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { useInboxCount } from "../lib/use-inbox-count.ts";
import { DashboardTickerMobile } from "./dashboard-ticker.tsx";
import { DesktopTopBar } from "./desktop-top-bar.tsx";
import { FeedbackFab } from "./feedback-fab.tsx";
import { Sidebar } from "./sidebar.tsx";

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
  const title = titleByRoute[loc.pathname] ?? "Heimdall";
  const inboxCount = useInboxCount(true);

  // TEMP DEBUG (ADR-007 nav-height investigation) — remove after diagnosis.
  const [dbg, setDbg] = useState("measuring…");
  useEffect(() => {
    const measure = () => {
      const root = document.getElementById("root")?.firstElementChild as HTMLElement | null;
      const navEl = document.querySelector("nav");
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;left:0;bottom:0;width:0;height:0;padding-bottom:env(safe-area-inset-bottom)";
      document.body.appendChild(probe);
      const safe = Math.round(probe.getBoundingClientRect().height);
      probe.remove();
      const r = navEl?.getBoundingClientRect();
      setDbg(
        `win${window.innerHeight} doc${document.documentElement.clientHeight} ` +
          `root${root ? Math.round(root.getBoundingClientRect().height) : "?"} ` +
          `safe${safe} navH${r ? Math.round(r.height) : "?"} ` +
          `gapBelow${r ? Math.round(window.innerHeight - r.bottom) : "?"}`,
      );
    };
    const t = setTimeout(measure, 250);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <div className="h-[100dvh] flex overflow-hidden">
      <div className="fixed top-14 inset-x-0 z-[60] bg-black/90 text-[9px] leading-tight text-[#5f5] mono px-1 py-0.5 text-center pointer-events-none">
        {dbg}
      </div>
      <Sidebar inboxCount={inboxCount} />

      <div className="flex-1 flex flex-col min-w-0">
        <DesktopTopBar />
        <header
          className="md:hidden shrink-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-bg)]/95 backdrop-blur"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div className="flex items-center justify-between px-4 h-12">
            <div className="flex items-baseline gap-3">
              <span className="display text-lg leading-none text-[var(--color-fg)]">Heimdall</span>
              <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
                · {title}
              </span>
            </div>
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              v{__FACTORY_VERSION__}
            </span>
          </div>
          <DashboardTickerMobile />
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-3 md:px-6 md:pt-5 md:pb-6 md:max-w-[1400px] md:w-full md:mx-auto">
          {children}
        </main>

        <nav
          className="md:hidden shrink-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-bg-1)]"
          // Cap the home-indicator clearance: the full env(safe-area-inset-bottom)
          // reserved a large dead band below the icons. 0.5rem keeps a little
          // breathing room while letting the bar sit closer to the screen edge.
          style={{ paddingBottom: "min(env(safe-area-inset-bottom), 0.5rem)" }}
        >
          <div className="grid grid-cols-4 h-12">
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

      <FeedbackFab />
    </div>
  );
}
