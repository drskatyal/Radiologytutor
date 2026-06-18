import { cn } from "./cn";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Adds default padding. Set false to control padding yourself. */
  padded?: boolean;
  /** Lifts the card with a hover border/elevation — for clickable cards. */
  interactive?: boolean;
}

/** Elevated content container. Use for list items, tiles, dialogs-in-page. */
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
        "rounded-xl border border-subtle bg-elevated shadow-sm",
        padded && "p-5",
        interactive &&
          "transition-colors duration-150 hover:border-strong hover:bg-elevated/70",
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
