import { cn } from "./cn";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary action(s) — typically a Button. */
  action?: React.ReactNode;
  className?: string;
}

/** Composed getting started view. Flat surface, no glow. */
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
        "flex flex-col items-start rounded-2xl bg-elevated p-8 text-left",
        className
      )}
    >
      {icon && (
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-primary [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold tracking-tight text-primary text-balance">{title}</h3>
      {description && (
        <p className="mt-2 max-w-[65ch] text-sm text-secondary text-pretty">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
