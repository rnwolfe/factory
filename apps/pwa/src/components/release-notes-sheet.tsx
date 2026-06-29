import { useQuery } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc.ts";
import { Inline } from "./markdown-block.tsx";

const LAST_SEEN_KEY = "factory.lastSeenVersion";

/**
 * Auto-opens once on the first view after an upgrade. The build embeds
 * `__FACTORY_VERSION__` at compile time; localStorage tracks the last
 * version the operator dismissed. First-install (null in localStorage) is
 * recorded silently so a fresh install doesn't open the sheet against an
 * empty history.
 */
export function ReleaseNotesSheet() {
  const [open, setOpen] = useState(false);
  const currentVersion = `v${__FACTORY_VERSION__}`;

  useEffect(() => {
    if (typeof window === "undefined") return;
    // The CLI emits `dev` when no tag is reachable — skip the auto-open so
    // local dev sessions don't get the sheet every reload.
    if (currentVersion === "vdev") return;
    const seen = window.localStorage.getItem(LAST_SEEN_KEY);
    if (seen === null) {
      window.localStorage.setItem(LAST_SEEN_KEY, currentVersion);
      return;
    }
    if (seen !== currentVersion) setOpen(true);
  }, [currentVersion]);

  if (!open) return null;
  return <SheetBody onClose={() => dismiss(currentVersion, setOpen)} />;
}

function dismiss(version: string, setOpen: (v: boolean) => void) {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, version);
  } catch {
    // Best-effort — if localStorage is unavailable (private mode, quota),
    // the sheet will re-open next load. Acceptable degradation.
  }
  setOpen(false);
}

function SheetBody({ onClose }: { onClose: () => void }) {
  const entry = useQuery({
    queryKey: ["changelog.latest"],
    queryFn: () => trpc.changelog.latest.query(),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
      role="dialog"
      aria-modal="true"
      aria-label="release notes"
    >
      <div className="surface w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-[var(--color-bg-1)] border-b border-[var(--color-line)] px-4 py-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles size={14} className="text-[var(--color-accent)] shrink-0" />
            <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
              what's new
            </span>
            {entry.data ? (
              <span className="mono text-[12px] text-[var(--color-fg-2)] tabular-nums">
                v{entry.data.version}
              </span>
            ) : null}
            {entry.data?.date ? (
              <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
                · {entry.data.date}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="text-[var(--color-fg-2)] hover:text-[var(--color-fg)] shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {entry.isLoading ? (
            <div className="space-y-2">
              <div className="skel h-3 w-3/4" />
              <div className="skel h-3 w-1/2" />
              <div className="skel h-3 w-2/3" />
            </div>
          ) : entry.isError ? (
            <p className="mono text-[11px] text-[var(--color-verdict-trashed)]">
              couldn't load changelog: {(entry.error as Error).message}
            </p>
          ) : entry.data ? (
            <EntryBody entry={entry.data} />
          ) : (
            <p className="mono text-[11px] text-[var(--color-fg-3)]">no entries yet.</p>
          )}
        </div>

        <div className="sticky bottom-0 bg-[var(--color-bg-1)] border-t border-[var(--color-line)] px-4 py-3 flex items-center justify-between gap-2">
          <Link
            to="/settings/release-notes"
            onClick={onClose}
            className="mono text-[11px] text-[var(--color-fg-2)] underline hover:text-[var(--color-fg)]"
          >
            view all releases
          </Link>
          <button type="button" onClick={onClose} className="btn">
            got it
          </button>
        </div>
      </div>
    </div>
  );
}

type Entry = NonNullable<Awaited<ReturnType<typeof trpc.changelog.latest.query>>>;

function EntryBody({ entry }: { entry: Entry }) {
  return (
    <>
      {entry.intro ? (
        <p className="text-[13px] text-[var(--color-fg-1)] leading-relaxed">
          <Inline text={entry.intro} />
        </p>
      ) : null}
      {entry.sections.map((section) => (
        <section key={section.heading}>
          <h3 className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2">
            {section.heading}
          </h3>
          <ul className="space-y-2.5">
            {section.bullets.map((bullet, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: bullets are positional, no stable id
              <li key={i} className="text-[13px] text-[var(--color-fg-1)] leading-relaxed">
                {bullet.lead ? (
                  <>
                    <span className="text-[var(--color-fg)] font-medium">
                      <Inline text={bullet.lead} />.
                    </span>{" "}
                    <span className="text-[var(--color-fg-2)]">
                      <Inline text={bullet.body} />
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-fg-2)]">
                    <Inline text={bullet.body} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
