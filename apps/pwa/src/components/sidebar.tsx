import {
  Activity,
  Archive,
  BookMarked,
  Cog,
  Inbox as InboxIcon,
  Layers,
  LineChart,
  ListChecks,
  PenLine,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/cn.ts";

interface NavItem {
  to: string;
  label: string;
  icon: typeof InboxIcon;
  end?: boolean;
}

const PRIMARY: NavItem[] = [
  { to: "/", label: "inbox", icon: InboxIcon, end: true },
  { to: "/ops", label: "ops", icon: Activity },
  { to: "/inbox/new", label: "capture", icon: PenLine },
  { to: "/projects", label: "projects", icon: Layers },
  { to: "/tasks", label: "open tasks", icon: ListChecks },
  { to: "/history", label: "history", icon: Archive },
  { to: "/metrics", label: "metrics", icon: LineChart },
  { to: "/memory", label: "memory", icon: BookMarked },
];

export function Sidebar({ inboxCount }: { inboxCount: number }) {
  return (
    <aside className="hidden md:flex w-[240px] flex-shrink-0 flex-col border-r border-[var(--color-line)] sticky top-0 h-screen bg-[var(--color-bg)]">
      <div className="px-4 h-12 border-b border-[var(--color-line)] flex items-center gap-3">
        <span className="display text-lg leading-none text-[var(--color-fg)]">Heimdall</span>
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          v{__FACTORY_VERSION__}
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {PRIMARY.map((item) => (
          <SidebarLink
            key={item.to}
            item={item}
            badge={item.to === "/" && inboxCount > 0 ? inboxCount : null}
          />
        ))}
      </nav>

      <div className="border-t border-[var(--color-line)] py-2 px-2">
        <SidebarLink item={{ to: "/settings", label: "settings", icon: Cog }} badge={null} />
      </div>
    </aside>
  );
}

function SidebarLink({ item, badge }: { item: NavItem; badge: number | null }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 px-2 h-9 text-[13px] rounded-sm transition-colors",
          isActive
            ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
            : "text-[var(--color-fg-2)] hover:text-[var(--color-fg-1)] hover:bg-[var(--color-bg-2)]",
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon size={15} strokeWidth={isActive ? 2.2 : 1.6} />
          <span>{item.label}</span>
          {badge !== null ? (
            <span className="ml-auto chip text-[10.5px] tabular-nums">{badge}</span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}
