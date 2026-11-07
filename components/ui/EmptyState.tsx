import { cn } from "./cn";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary action(s) — typically a Button. */
  action?: React.ReactNode;
  className?: string;
  /** `imaging`: on a pure-black reading-room surface (the free viewer). */
  tone?: "default" | "imaging";
}

/** Composed getting started view. Flat surface, no glow. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  tone = "default",
}: EmptyStateProps) {
  const imaging = tone === "imaging";
  return (
    <div
      className={cn(
        "flex flex-col items-start rounded-2xl border p-8 text-left",
        imaging ? "border-white/10 bg-white/[0.03]" : "border-subtle bg-surface",
        className
      )}
    >
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent [&_svg]:h-6 [&_svg]:w-6">
          {icon}
        </div>
      )}
      <h3 className={cn("text-base font-semibold tracking-tight text-balance", imaging ? "text-white" : "text-primary")}>{title}</h3>
      {description && (
        <p className={cn("mt-2 max-w-[65ch] text-sm text-pretty", imaging ? "text-white/70" : "text-secondary")}>{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
