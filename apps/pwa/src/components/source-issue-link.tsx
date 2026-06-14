import type { MouseEventHandler } from "react";
import { cn } from "../lib/cn.ts";

export function sourceIssueLabel(
  number: number | null | undefined,
  title: string | null | undefined,
) {
  const issueNumber = `#${number ?? "?"}`;
  const issueTitle = title?.trim() ?? "";
  return issueTitle ? `${issueNumber} ${issueTitle}` : issueNumber;
}

export function SourceIssueLink({
  number,
  title,
  href,
  className,
  onClick,
}: {
  number: number | null | undefined;
  title: string | null | undefined;
  href: string | null | undefined;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const label = sourceIssueLabel(number, title);
  const cleanHref = typeof href === "string" && href.trim().length > 0 ? href.trim() : null;

  if (!cleanHref) {
    return <span className={className}>{label}</span>;
  }

  return (
    <a
      href={cleanHref}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className={cn(
        "text-[var(--color-accent)] underline decoration-[var(--color-line)] underline-offset-4 hover:text-[var(--color-fg)]",
        className,
      )}
    >
      {label}
    </a>
  );
}
