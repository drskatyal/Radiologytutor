import { cn } from "./cn";

/**
 * The single content-width + padding rhythm for every page body.
 *
 * Every route renders its main content inside a `PageContainer` so the whole
 * app shares ONE max-width and ONE horizontal/vertical padding scale. Don't
 * hand-roll `mx-auto max-w-* px-* py-*` wrappers per page — use this.
 */
export interface PageContainerProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Content max-width. `default` (6xl) suits most pages; `narrow` (4xl) for
   *  text/form-dense pages; `wide` (1500px) for media/viewer layouts. */
  width?: "narrow" | "default" | "wide";
}

const WIDTHS = {
  narrow: "max-w-4xl",
  default: "max-w-6xl",
  wide: "max-w-[1500px]",
} as const;

export function PageContainer({
  width = "default",
  className,
  children,
  ...props
}: PageContainerProps) {
  return (
    <div
      className={cn("mx-auto px-6 py-8 sm:px-8", WIDTHS[width], className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface SectionHeadingProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional right-aligned content (a count badge, a link, an action). */
  aside?: React.ReactNode;
  /** Optional leading icon, sized to the heading. */
  icon?: React.ReactNode;
}

/**
 * Consistent in-page section header — a display title with an optional
 * description and right-aligned aside. Use to introduce a content block so
 * every section reads the same way across the product.
 */
export function SectionHeading({
  title,
  description,
  aside,
  icon,
  className,
  ...props
}: SectionHeadingProps) {
  return (
    <div
      className={cn("flex flex-wrap items-end justify-between gap-3", className)}
      {...props}
    >
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-primary [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:text-accent">
          {icon}
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  );
}
