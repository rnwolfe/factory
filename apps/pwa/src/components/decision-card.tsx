import { ArrowRight, MoreHorizontal, Trash2 } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";

export interface DecisionRow {
  id: string;
  kind: "triage" | "tag_change";
  outcome: string;
  weightedScore: number | null;
  uncertainty: number | null;
  createdAt: number;
  payload: {
    rationale?: string;
    title_suggestion?: string;
    clarifying_questions?: string[];
    what_would_change_verdict?: string;
    [k: string]: unknown;
  };
  ideaId?: string | null;
  projectId?: string | null;
}

interface Props {
  decision: DecisionRow;
  ideaText?: string | null;
  onAction: (action: "approve" | "park" | "trash" | "decompose" | "dismiss") => void;
  onOpen: () => void;
  index?: number;
}

const SWIPE_THRESHOLD = 96;

function verdictTone(outcome: string) {
  if (outcome.startsWith("greenlit")) return "chip-greenlit";
  if (outcome.startsWith("parked")) return "chip-parked";
  if (outcome.startsWith("trashed")) return "chip-trashed";
  if (outcome.startsWith("decompose")) return "chip-decompose";
  return "";
}

function uncertaintyLabel(u: number | null): string {
  if (u == null) return "—";
  if (u < 0.2) return "low";
  if (u < 0.4) return "med";
  return "high";
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function DecisionCard({ decision, ideaText, onAction, onOpen, index = 0 }: Props) {
  const [dx, setDx] = useState(0);
  const startX = useRef<number | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    startX.current = e.clientX;
    cardRef.current?.setPointerCapture(e.pointerId);
    longPressTimer.current = setTimeout(() => setMenuOpen(true), 520);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (startX.current == null) return;
    const delta = e.clientX - startX.current;
    if (Math.abs(delta) > 6 && longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    setDx(delta);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    cardRef.current?.releasePointerCapture(e.pointerId);
    if (dx > SWIPE_THRESHOLD) {
      onAction("approve");
    } else if (dx < -SWIPE_THRESHOLD) {
      onAction("dismiss");
    }
    setDx(0);
    startX.current = null;
  };

  // Snap dx visually to threshold for clean affordance.
  const cappedDx = Math.max(-160, Math.min(160, dx));

  // Close long-press menu on outside tap.
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    if (!menuOpen) return;
    const fn = () => closeMenu();
    document.addEventListener("pointerdown", fn, { capture: true, once: true });
    return () => document.removeEventListener("pointerdown", fn, { capture: true });
  }, [menuOpen, closeMenu]);

  const headline =
    decision.payload.title_suggestion ?? (ideaText ? ideaText.slice(0, 80) : decision.outcome);

  const score = decision.weightedScore != null ? decision.weightedScore.toFixed(1) : "—";
  const isTriage = decision.kind === "triage";

  return (
    <div
      className="relative overflow-hidden surface drop-in"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {/* swipe trays */}
      <div
        className="swipe-tray swipe-tray-approve"
        style={{ opacity: dx > 0 ? Math.min(1, dx / SWIPE_THRESHOLD) : 0 }}
      >
        <span>approve →</span>
      </div>
      <div
        className="swipe-tray swipe-tray-trash"
        style={{ opacity: dx < 0 ? Math.min(1, -dx / SWIPE_THRESHOLD) : 0 }}
      >
        <span>← dismiss</span>
      </div>

      <div
        ref={cardRef}
        className="relative bg-[var(--color-bg-1)] select-none"
        style={{
          transform: `translateX(${cappedDx}px)`,
          transition: dx === 0 ? "transform 180ms ease" : "none",
          touchAction: "pan-y",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
          setDx(0);
          startX.current = null;
        }}
      >
        <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn("chip", verdictTone(decision.outcome))}>{decision.outcome}</span>
            {isTriage ? <span className="chip">triage</span> : <span className="chip">tag</span>}
            <span className="mono text-[10.5px] text-[var(--color-fg-3)]">
              · {timeAgo(decision.createdAt)} ago
            </span>
          </div>
          <button
            type="button"
            aria-label="more"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="text-[var(--color-fg-2)] hover:text-[var(--color-fg)] p-1 -mr-1"
          >
            <MoreHorizontal size={16} />
          </button>
        </div>

        <button type="button" onClick={onOpen} className="w-full text-left px-4 pb-3">
          <div className="display text-[17px] leading-snug text-[var(--color-fg)] line-clamp-2">
            {headline}
          </div>
          {decision.payload.rationale ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-2)] line-clamp-2">
              {decision.payload.rationale}
            </p>
          ) : null}
        </button>

        <div className="px-4 pb-3 flex items-center gap-2 mono text-[10.5px] text-[var(--color-fg-3)] uppercase tracking-[0.14em]">
          <span>score {score}</span>
          <span>·</span>
          <span>uncertainty {uncertaintyLabel(decision.uncertainty)}</span>
        </div>

        {isTriage ? (
          <div className="grid grid-cols-4 border-t border-[var(--color-line)]">
            <ActionBtn
              label="approve"
              tone="primary"
              onClick={() => onAction("approve")}
              showArrow
            />
            <ActionBtn label="park" onClick={() => onAction("park")} />
            <ActionBtn label="decompose" onClick={() => onAction("decompose")} />
            <ActionBtn label="trash" tone="danger" onClick={() => onAction("trash")} />
          </div>
        ) : (
          <div className="grid grid-cols-2 border-t border-[var(--color-line)]">
            <ActionBtn label="confirm" tone="primary" onClick={() => onAction("approve")} />
            <ActionBtn label="dismiss" onClick={() => onAction("dismiss")} />
          </div>
        )}
      </div>

      {menuOpen ? (
        <div className="absolute right-3 top-12 z-10 surface-2 shadow-[var(--shadow-elev)] py-1 min-w-[180px] text-[13px]">
          <MenuItem onClick={onOpen} label="see full rationale" />
          {decision.payload.what_would_change_verdict ? (
            <MenuItem onClick={onOpen} label="what would change verdict" />
          ) : null}
          <MenuItem
            onClick={() => onAction("dismiss")}
            label="dismiss"
            icon={<Trash2 size={13} />}
          />
        </div>
      ) : null}
    </div>
  );
}

function ActionBtn({
  label,
  tone,
  onClick,
  showArrow,
}: {
  label: string;
  tone?: "primary" | "danger";
  onClick: () => void;
  showArrow?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-12 flex items-center justify-center gap-1 mono text-[11px] uppercase tracking-[0.14em] border-r border-[var(--color-line)] last:border-r-0",
        tone === "primary"
          ? "text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
          : tone === "danger"
            ? "text-[var(--color-verdict-trashed)] hover:bg-[var(--color-verdict-trashed-soft)]"
            : "text-[var(--color-fg-1)] hover:bg-[var(--color-bg-2)]",
      )}
    >
      {label}
      {showArrow ? <ArrowRight size={12} /> : null}
    </button>
  );
}

function MenuItem({
  label,
  onClick,
  icon,
}: {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-2 hover:bg-[var(--color-bg-3)] flex items-center gap-2 text-[var(--color-fg-1)]"
    >
      {icon}
      {label}
    </button>
  );
}
