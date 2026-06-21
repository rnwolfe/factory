import type { MouseEventHandler, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/cn.ts";

type SourceLinkVariant = "inline" | "chip";

export interface ProvenanceLink {
  kind: "issue" | "plan" | "finding" | "audit" | "decision";
  label: string;
  href: string;
}

export function sourceIssueLabel(
  number: number | null | undefined,
  title: string | null | undefined,
): string | null {
  const issueNumber = typeof number === "number" ? `#${number}` : null;
  const issueTitle = title?.trim() ?? "";

  if (issueNumber && issueTitle) return `${issueNumber} ${issueTitle}`;
  if (issueNumber) return issueNumber;
  if (issueTitle) return issueTitle;
  return null;
}

function hasVisibleLabel(label: ReactNode): boolean {
  if (label == null || label === false) return false;
  if (typeof label === "string") return label.trim().length > 0;
  return true;
}

export function trustedSourceHref(href: string | null | undefined): string | null {
  const target = typeof href === "string" ? href.trim() : "";
  if (!target) return null;

  if (target.startsWith("/") && !target.startsWith("//")) return target;

  try {
    const url = new URL(target);
    if (url.protocol === "https:") return url.href;
  } catch {
    return null;
  }

  return null;
}

export function trustedGithubIssueHref(
  href: string | null | undefined,
  number?: number | null,
): string | null {
  const target = trustedSourceHref(href);
  if (!target || target.startsWith("/")) return null;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  if (parts.length !== 4 || parts[2] !== "issues") return null;
  if (typeof number === "number" && parts[3] !== String(number)) return null;
  return url.href;
}

function variantClass(variant: SourceLinkVariant): string {
  if (variant === "chip") {
    return "inline-flex max-w-full items-center gap-1 rounded-[2px] border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] px-1.5 py-[2px] mono text-[10.5px] leading-none text-[var(--color-accent)] no-underline hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]";
  }

  return "text-[var(--color-accent)] no-underline border-b border-[var(--color-line)] hover:border-[var(--color-accent-line)] hover:text-[var(--color-fg)]";
}

export function SourceLink({
  label,
  href,
  className,
  onClick,
  variant = "inline",
}: {
  label: ReactNode;
  href?: string | null;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  variant?: SourceLinkVariant;
}) {
  if (!hasVisibleLabel(label)) return null;

  const target = trustedSourceHref(href);
  if (!target) {
    return <span className={className}>{label}</span>;
  }

  return (
    <a
      href={target}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className={cn(variantClass(variant), className)}
    >
      {label}
    </a>
  );
}

export function SourceIssueLink({
  number,
  title,
  href,
  fallbackLabel = "GitHub issue",
  className,
  onClick,
  variant,
}: {
  number: number | null | undefined;
  title: string | null | undefined;
  href: string | null | undefined;
  fallbackLabel?: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  variant?: SourceLinkVariant;
}) {
  return (
    <SourceLink
      label={sourceIssueLabel(number, title) ?? fallbackLabel}
      href={trustedGithubIssueHref(href, number)}
      className={className}
      onClick={onClick}
      variant={variant}
    />
  );
}

export function ProvenanceLinks({
  links,
  className,
  variant = "chip",
}: {
  links?: ProvenanceLink[] | null;
  className?: string;
  variant?: SourceLinkVariant;
}) {
  if (!links || links.length === 0) return null;
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 flex-wrap", className)}>
      {links.map((link) => {
        const classes = variantClass(variant);
        const target = trustedSourceHref(link.href);
        if (!target) {
          return (
            <span key={`${link.kind}:${link.label}`} className={classes}>
              {link.label}
            </span>
          );
        }
        if (target.startsWith("/")) {
          return (
            <Link key={`${link.kind}:${target}`} to={target} className={classes}>
              {link.label}
            </Link>
          );
        }
        return (
          <a
            key={`${link.kind}:${target}`}
            href={target}
            target="_blank"
            rel="noreferrer"
            className={classes}
          >
            {link.label}
          </a>
        );
      })}
    </span>
  );
}
