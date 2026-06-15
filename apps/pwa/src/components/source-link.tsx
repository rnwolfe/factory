import type { MouseEventHandler, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/cn.ts";

type SourceLinkVariant = "inline" | "chip";

export interface ProvenanceLink {
  kind: "issue" | "plan" | "finding" | "audit";
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

function cleanHref(href: string | null | undefined): string | null {
  return typeof href === "string" && href.trim().length > 0 ? href.trim() : null;
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

  const target = cleanHref(href);
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
      href={href}
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
        if (link.href.startsWith("/")) {
          return (
            <Link key={`${link.kind}:${link.href}`} to={link.href} className={classes}>
              {link.label}
            </Link>
          );
        }
        return (
          <a
            key={`${link.kind}:${link.href}`}
            href={link.href}
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
