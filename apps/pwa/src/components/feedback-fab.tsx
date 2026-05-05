import { MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { FeedbackDrawer } from "./feedback-drawer.tsx";

/**
 * Floating action button anchored above the bottom nav bar's safe-area inset.
 * Opens a drawer for capturing feedback on Factory itself.
 */
export function FeedbackFab() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="capture feedback"
        className="fixed right-4 z-40 h-12 w-12 rounded-full surface flex items-center justify-center text-[var(--color-fg-1)] hover:text-[var(--color-accent)] active:bg-[var(--color-bg-2)] shadow-lg border border-[var(--color-line)]"
        style={{ bottom: "calc(72px + env(safe-area-inset-bottom))" }}
      >
        <MessageSquarePlus size={18} />
      </button>
      {open ? (
        <FeedbackDrawer
          onClose={() => setOpen(false)}
          contextRoute={location.pathname + location.search}
          contextHint={routeHint(location.pathname)}
        />
      ) : null}
    </>
  );
}

/**
 * Lightweight pathname → human label mapping for the contextHint field.
 * Helps the agent (in cut 6) understand what surface the operator was on
 * without parsing the full pathname.
 */
function routeHint(pathname: string): string {
  if (pathname === "/" || pathname.startsWith("/inbox")) return "inbox";
  if (pathname.startsWith("/decisions/")) return "decision-detail";
  if (pathname.startsWith("/plans/")) return "plan-detail";
  if (pathname.startsWith("/projects/") && pathname.includes("/audits/")) return "audit-pane";
  if (pathname.startsWith("/projects/") && pathname.includes("/runs/")) return "run-pane";
  if (pathname.startsWith("/projects/") && pathname.includes("/tasks/")) return "task-detail";
  if (pathname.startsWith("/projects/") && pathname.endsWith("/deepen")) return "deepen";
  if (pathname.startsWith("/projects/import")) return "import-project";
  if (pathname.startsWith("/projects/")) return "project-detail";
  if (pathname === "/projects") return "projects";
  if (pathname.startsWith("/settings/prompts/")) return "prompt-detail";
  if (pathname === "/settings/prompts") return "prompts-viewer";
  if (pathname.startsWith("/settings/rubrics/")) return "rubric-detail";
  if (pathname === "/settings/rubrics") return "rubrics-viewer";
  if (pathname === "/settings/worktrees") return "worktrees-admin";
  if (pathname === "/settings") return "settings";
  if (pathname === "/metrics") return "metrics";
  if (pathname.startsWith("/feedback/")) return "feedback-detail";
  return "other";
}
