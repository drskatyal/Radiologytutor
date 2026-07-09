import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "./cn";

export interface BreadcrumbItem {
  label: string;
  /** Omit on the last item — it renders as the current page (no link). */
  href?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * The single breadcrumb row for the app. Replaces the hand-rolled
 * "<ArrowLeft/> Library / Author" JSX previously duplicated per page. The
 * first item gets a leading back-arrow; the last item is always the current
 * page (rendered as plain text, no link, even if it carries an `href`).
 */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex flex-wrap items-center gap-2 text-xs text-muted", className)}
    >
      {items.map((item, i) => {
        const isFirst = i === 0;
        const isLast = i === items.length - 1;
        return (
          <span key={`${item.label}-${i}`} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden="true">/</span>}
            {item.href && !isLast ? (
              <Link
                href={item.href}
                className="inline-flex items-center gap-1 font-medium transition-colors hover:text-primary"
              >
                {isFirst && <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />}
                {item.label}
              </Link>
            ) : (
              <span
                className={isLast ? "text-secondary" : undefined}
                aria-current={isLast ? "page" : undefined}
              >
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
