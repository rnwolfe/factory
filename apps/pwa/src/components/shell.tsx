import { useQueryClient } from "@tanstack/react-query";
import { Cog, Inbox as InboxIcon, Layers, LineChart, PenLine } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "../lib/cn.ts";
import { useInboxCount } from "../lib/use-inbox-count.ts";
import { useNeedsYouCount } from "../lib/use-needs-you-count.ts";
import { DashboardTickerMobile } from "./dashboard-ticker.tsx";
import { DesktopTopBar } from "./desktop-top-bar.tsx";
import { FeedbackFab } from "./feedback-fab.tsx";
import { PullToRefresh } from "./pull-to-refresh.tsx";
import { Sidebar } from "./sidebar.tsx";

const NAV: Array<{ to: string; label: string; icon: typeof InboxIcon }> = [
  { to: "/", label: "inbox", icon: InboxIcon },
  { to: "/inbox/new", label: "capture", icon: PenLine },
  { to: "/projects", label: "projects", icon: Layers },
  { to: "/metrics", label: "metrics", icon: LineChart },
  { to: "/settings", label: "settings", icon: Cog },
];

export function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const titleByRoute: Record<string, string> = {
    "/": "decisions",
    "/inbox/new": "capture",
    "/projects": "projects",
    "/tasks": "open tasks",
    "/metrics": "metrics",
    "/memory": "operator memory",
    "/settings": "settings",
  };
  const title = titleByRoute[loc.pathname] ?? "Heimdall";
  const inboxCount = useInboxCount(true);
  // The mobile nav badge is amber = "needs you", so it tracks only pending
  // decisions, not the all-feeds total the desktop sidebar shows.
  const needsYouCount = useNeedsYouCount(true);

  // Pull-to-refresh refetches the active route's data without per-route
  // wiring: invalidate every query but only refetch the ones with live
  // observers (the mounted route). The promise settles when those refetches
  // do, so the indicator holds until the data is fresh.
  const queryClient = useQueryClient();
  const onRefresh = useCallback(
    () => queryClient.invalidateQueries({ refetchType: "active" }),
    [queryClient],
  );

  return (
    // 100lvh, not 100dvh: in this installed PWA, dvh/svh/vh all resolve to the
    // status-bar-excluded height (e.g. 873 on a 932px screen), which — since the
    // shell is top-anchored — leaves the bottom of the screen uncovered (a strip
    // of page background below the nav). lvh is the only unit that equals the
    // full physical screen, so the nav reaches the true bottom edge. (ADR-007
    // nav investigation — confirmed on-device: scr932 / dvh873 / lvh932.)
    <div className="h-[100lvh] flex overflow-hidden">
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

        <PullToRefresh
          onRefresh={onRefresh}
          className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-3 md:px-6 md:pt-5 md:pb-6 md:max-w-[1400px] md:w-full md:mx-auto"
        >
          {children}
        </PullToRefresh>

        <nav
          className="md:hidden shrink-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-bg-1)]"
          // Cap the home-indicator clearance: the full env(safe-area-inset-bottom)
          // reserved a large dead band below the icons. 0.5rem keeps a little
          // breathing room while letting the bar sit closer to the screen edge.
          style={{ paddingBottom: "min(env(safe-area-inset-bottom), 0.5rem)" }}
        >
          <div className="grid grid-cols-5 h-12">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "relative flex flex-col items-center justify-center gap-1 text-[10.5px] uppercase tracking-[0.18em]",
                    // active tab is NOT amber — amber is rationed to "needs you".
                    // active reads via a bright icon + a top tick; inactive is muted.
                    isActive
                      ? "text-[var(--color-fg-1)]"
                      : "text-[var(--color-fg-3)] active:bg-[var(--color-bg-2)]",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <span
                        className="absolute top-0 h-0.5 w-[26px] bg-[var(--color-fg-1)] rounded-b-[2px]"
                        aria-hidden
                      />
                    ) : null}
                    <span className="relative">
                      <item.icon size={18} strokeWidth={isActive ? 2 : 1.6} />
                      {/* the inbox tab carries the amber attention badge */}
                      {item.to === "/" && needsYouCount > 0 ? (
                        <span
                          role="status"
                          className="absolute -top-1.5 -right-2 min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--color-accent)] text-[hsl(30_30%_8%)] mono text-[9px] font-medium flex items-center justify-center tabular-nums"
                          aria-label={`${needsYouCount} need you`}
                        >
                          {needsYouCount > 9 ? "9+" : needsYouCount}
                        </span>
                      ) : null}
                    </span>
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
