import { cn } from "./cn";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Adds default padding. Set false to control padding yourself. */
  padded?: boolean;
  /** Lifts the card with a hover border/elevation — for clickable cards. */
  interactive?: boolean;
}

/**
 * Elevated content container with rounded border and shadow.
 *
 * **Do not use on marketplace browse** (home, library, course/author lists) —
 * use `EditorialRow` instead. Card is for auth forms, admin modals, and
 * confirm dialogs-in-page only.
 */
export function Card({
  padded = true,
  interactive = false,
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "relative rounded-xl border border-subtle bg-elevated shadow-sm surface-hairline",
        padded && "p-4",
        interactive &&
          "transition-[transform,border-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-sm font-semibold text-primary", className)} {...props}>
      {children}
    </h3>
  );
}
