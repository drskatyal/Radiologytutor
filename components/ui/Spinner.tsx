import { Loader2 } from "lucide-react";
import { cn } from "./cn";

const SIZES = {
  sm: "h-3.5 w-3.5",
  md: "h-5 w-5",
  lg: "h-8 w-8",
} as const;

export interface SpinnerProps {
  size?: keyof typeof SIZES;
  /** Optional accessible label; rendered visually hidden. */
  label?: string;
  className?: string;
}

/** Indeterminate loading spinner. Inherits `currentColor` for its arc. */
export function Spinner({ size = "md", label, className }: SpinnerProps) {
  return (
    <span role="status" aria-live="polite" className="inline-flex">
      <Loader2
        aria-hidden="true"
        className={cn("animate-spin", SIZES[size], className)}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
