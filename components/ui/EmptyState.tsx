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
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-strong bg-surface/50 px-6 py-12 text-center",
        className
      )}
    >
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-elevated text-secondary [&_svg]:h-6 [&_svg]:w-6">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-primary">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
