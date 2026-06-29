/**
 * Heimdall's mark — a watcher's eye (vesica + filled pupil). The system's
 * presence: rendered wherever Heimdall "watches" or "reads" — the inbox watch
 * strip, the Capture reassurance line, The Watch panel, and the system autonomy
 * card. Teal by default (the working/autonomous voice); pass a className to
 * override the color via `currentColor`.
 */
export function HeimdallMark({
  size = 14,
  className = "text-[var(--color-working)]",
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* vesica — two opposing arcs forming the eye lens */}
      <path d="M2 12s4-6.5 10-6.5S22 12 22 12s-4 6.5-10 6.5S2 12 2 12Z" />
      {/* filled pupil */}
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
