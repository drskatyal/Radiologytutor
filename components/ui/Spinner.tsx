import { cn } from "./cn";

const SIZES = {
  sm: "h-3.5 w-3.5 border-[1.5px]",
  md: "h-5 w-5 border-2",
  lg: "h-8 w-8 border-2",
} as const;

export interface SpinnerProps {
  size?: keyof typeof SIZES;
  /** Optional accessible label; rendered visually hidden. */
  label?: string;
  className?: string;
}

/** Indeterminate loading spinner. Inherits `currentColor` for its accent arc. */
export function Spinner({ size = "md", label, className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-block animate-spin rounded-full border-current border-r-transparent align-[-0.125em]",
        SIZES[size],
        className
      )}
    >
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
