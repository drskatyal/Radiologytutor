"use client";

import { useId } from "react";
import { cn } from "./cn";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** Rendered next to the label, e.g. "3 slices". Defaults to the number. */
  valueLabel?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Labelled range input, themed with the accent token. Keyboard: arrows / PgUp / PgDn / Home / End. */
export function Slider({ label, value, min, max, step = 1, onChange, valueLabel, description, disabled, className }: SliderProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5 py-2", disabled && "opacity-50", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium text-primary">
          {label}
        </label>
        <span className="text-xs text-secondary tabular-nums">{valueLabel ?? value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed"
      />
      {description && <span className="text-xs text-muted">{description}</span>}
    </div>
  );
}
