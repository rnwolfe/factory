import { useEffect, useState } from "react";
import { MarkdownBlock } from "./markdown-block.tsx";

type Mode = "rendered" | "raw";

interface Props {
  source: string;
  /**
   * localStorage key for sticking operator preference across reloads.
   * Use a per-surface key (e.g. `mdView.audit-report`, `mdView.task-body`).
   */
  storageKey: string;
  /** Default mode if no localStorage entry exists. Default: "rendered". */
  defaultMode?: Mode;
  /** Optional aria-label for the toggle button (defaults to "toggle render mode"). */
  toggleLabel?: string;
  /** Extra className for the wrapping container. */
  className?: string;
}

function readMode(key: string, fallback: Mode): Mode {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v === "raw" || v === "rendered") return v;
  } catch {
    // ignore
  }
  return fallback;
}

function writeMode(key: string, mode: Mode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, mode);
  } catch {
    // ignore — storage may be denied
  }
}

/**
 * Markdown body with a per-surface `[raw]` / `[rendered]` toggle. The toggle
 * sits in the top-right of the block (mono link, dispatcher's-console feel).
 * Operator's choice is sticky per-`storageKey` in localStorage so a code-
 * heavy report can default to raw on the next visit without affecting other
 * surfaces.
 *
 * Same renderer (`MarkdownBlock`) cut 3 introduced — no new render logic
 * here, just the toggle plumbing.
 */
export function MarkdownView({
  source,
  storageKey,
  defaultMode = "rendered",
  toggleLabel = "toggle render mode",
  className,
}: Props) {
  const [mode, setMode] = useState<Mode>(() => readMode(storageKey, defaultMode));

  // If the storageKey changes (e.g., switching between two reports on the
  // same mounted component) re-read the stored value.
  useEffect(() => {
    setMode(readMode(storageKey, defaultMode));
  }, [storageKey, defaultMode]);

  const flip = () => {
    const next: Mode = mode === "rendered" ? "raw" : "rendered";
    setMode(next);
    writeMode(storageKey, next);
  };

  return (
    <div className={`md-view ${className ?? ""}`}>
      <div className="md-view-toolbar">
        <button type="button" onClick={flip} aria-label={toggleLabel} className="md-view-toggle">
          [{mode === "rendered" ? "raw" : "rendered"}]
        </button>
      </div>
      {mode === "rendered" ? (
        <MarkdownBlock source={source} />
      ) : (
        <pre className="md-view-raw">{source}</pre>
      )}
    </div>
  );
}
