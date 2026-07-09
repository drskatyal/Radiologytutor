import { cn } from "./cn";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary action(s) — typically a Button. */
  action?: React.ReactNode;
  className?: string;
}

/** Friendly placeholder for empty lists / no-data states. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-strong bg-surface/60 px-6 py-9 text-center shadow-sm",
        className
      )}
    >
      {/* Faint accent wash behind the icon for depth. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-6 h-24 w-24 -translate-x-1/2 rounded-full bg-accent/10 blur-3xl"
      />
      {icon && (
        <div className="relative mb-3.5 flex h-11 w-11 items-center justify-center rounded-xl border border-subtle bg-elevated text-accent shadow-sm surface-hairline [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <h3 className="relative font-display text-base font-semibold tracking-tight text-primary">
        {title}
      </h3>
      {description && (
        <p className="relative mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
          {description}
        </p>
      )}
      {action && <div className="relative mt-5">{action}</div>}
    </div>
  );
}
