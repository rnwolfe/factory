/**
 * System-scope autonomy settings (ADR-016). Its own focused sub-route off
 * /settings rather than another block of rows in the already-dense settings
 * list — the panel itself is preset-first with everything behind disclosure.
 */

import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { AutonomyPanel } from "../components/autonomy-panel.tsx";

export function AutonomySettings() {
  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="flex items-center gap-2">
        <Link to="/settings" className="btn btn-ghost h-8 px-2" aria-label="back to settings">
          <ArrowLeft size={14} />
        </Link>
        <span className="display text-lg text-[var(--color-fg)]">autonomy</span>
        <span className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)]">
          · system policy
        </span>
      </div>

      <p className="px-1 text-[12px] text-[var(--color-fg-2)] leading-relaxed">
        the system-wide autonomy policy — trust ladder, merge gate, the watch, auto-run, retry, and
        alert routing. projects inherit this and may override per-knob. pick a preset, or open
        advanced to tune individual knobs.
      </p>

      <AutonomyPanel scope="system" />
    </div>
  );
}
