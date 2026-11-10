"use client";

import { useId } from "react";
import { cn } from "./cn";

export interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** "imaging": on the viewer's black panels (light type); default follows the theme. */
  tone?: "default" | "imaging";
}

/** An on / off setting: label and description left, the switch right. Space / Enter toggles. */
export function Switch({ label, checked, onChange, description, disabled, className, tone = "default" }: SwitchProps) {
  const id = useId();
  const imaging = tone === "imaging";
  return (
    <div className={cn("flex items-start justify-between gap-4 py-2", disabled && "opacity-50", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className={cn("text-sm font-medium", imaging ? "text-white" : "text-primary")}>
          {label}
        </label>
        {description && <span className={cn("text-xs", imaging ? "text-white/50" : "text-muted")}>{description}</span>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2",
          imaging ? "focus-visible:ring-offset-black" : "focus-visible:ring-offset-canvas",
          "disabled:cursor-not-allowed",
          checked ? "bg-accent" : imaging ? "bg-white/20 hover:bg-white/25" : "bg-overlay hover:bg-strong"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150",
            checked ? "translate-x-[18px]" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
