import { cn } from "./cn";

export interface PanelProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Optional header rendered with a bottom divider. */
  title?: React.ReactNode;
  /** Right-aligned actions in the header row. */
  actions?: React.ReactNode;
  /** Pad the body. */
  padded?: boolean;
}

/**
 * A structural surface — flatter than a Card, meant for layout regions like a
 * sidebar list, a toolbar container, or a viewer side rail.
 */
export function Panel({
  title,
  actions,
  padded = true,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-xl border border-subtle bg-surface",
        className
      )}
      {...props}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
          {title ? (
            <div className="text-sm font-semibold text-primary">{title}</div>
          ) : (
            <span />
          )}
          {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
        </header>
      )}
      <div className={cn("min-h-0 flex-1", padded && "p-4")}>{children}</div>
    </section>
  );
}
