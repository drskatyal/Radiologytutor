import { cn } from "./cn";

export interface ProgressBarProps {
  /** 0…1, or null for an indeterminate bar (still moving, not a spinner). */
  value: number | null;
  /** Accessible name, e.g. "Loading voice commands". */
  label: string;
  /** Text read out with the value, e.g. "12.4 of 40.1 MB". */
  valueText?: string;
  className?: string;
}

/** Determinate progress (role="progressbar"), themed by tokens. */
export function ProgressBar({ value, label, valueText, className }: ProgressBarProps) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={valueText}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-white/10", className)}
    >
      {pct == null ? (
        <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-accent" />
      ) : (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
          // Dynamic: the measured fraction.
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}
