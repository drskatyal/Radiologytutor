import Link from "next/link";
import { cn } from "./cn";

export interface EditorialRowProps {
  /** Navigate to this URL — renders as a Next.js Link. */
  href?: string;
  /** Leading visual — e.g. FilmPlane thumbnail or icon tile. */
  leading?: React.ReactNode;
  /** Primary title (display serif). */
  title: React.ReactNode;
  /** Secondary line — meta, author, counts. */
  subtitle?: React.ReactNode;
  /** Right column — trailing action, arrow, status. */
  meta?: React.ReactNode;
  /** Inline badge or trust signal beside the title row. */
  badge?: React.ReactNode;
  /** Click handler — renders as a button when no href. */
  onClick?: () => void;
  className?: string;
}

const rowClassName = (className?: string) =>
  cn(
    "group editorial-divide flex w-full items-center gap-4 py-4 text-left",
    "first:border-t first:border-subtle",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
    className
  );

/**
 * Generic hairline list row for marketplace browse surfaces.
 * No Card wrapper — pair with FilmPlane in `leading` for case rows.
 */
export function EditorialRow({
  href,
  leading,
  title,
  subtitle,
  meta,
  badge,
  onClick,
  className,
}: EditorialRowProps) {
  const content = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <h3 className="min-w-0 font-display text-[0.95rem] font-semibold tracking-tight text-primary sm:text-base">
            {title}
          </h3>
          {badge ? <div className="shrink-0">{badge}</div> : null}
        </div>
        {subtitle ? (
          <p className="mt-1 truncate text-xs text-muted sm:text-[13px]">{subtitle}</p>
        ) : null}
      </div>
      {meta ? <div className="hidden shrink-0 sm:block">{meta}</div> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={rowClassName(className)}>
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={rowClassName(className)}>
        {content}
      </button>
    );
  }

  return <div className={rowClassName(className)}>{content}</div>;
}
