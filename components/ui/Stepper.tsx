"use client";

import { Check } from "lucide-react";
import { cn } from "./cn";

export interface StepperStep {
  id: string;
  label: string;
  caption: string;
}

export interface StepperProps {
  steps: StepperStep[];
  currentId: string;
  /** Called when a COMPLETED step is clicked. Upcoming/active steps aren't clickable. */
  onStepClick?: (id: string) => void;
  className?: string;
}

/**
 * The shared step-rail primitive. Originally lived inline in the case-creation
 * modal; now used by BOTH the create-a-case flow and the recording studio so
 * the 4-step journey (Details -> Upload -> Record -> Publish) renders as one
 * continuous, visible arc across routes.
 */
export function Stepper({ steps, currentId, onStepClick, className }: StepperProps) {
  const currentIdx = steps.findIndex((s) => s.id === currentId);
  return (
    <ol className={cn("flex items-center gap-2", className)} aria-label="Steps">
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const clickable = done && !!onStepClick;
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onStepClick?.(s.id)}
              className={cn(
                "flex min-w-0 items-center gap-2.5 rounded-lg py-0.5 text-left",
                clickable &&
                  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                !clickable && "cursor-default"
              )}
            >
              <span
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors",
                  done && "border-accent/40 bg-accent/15 text-accent",
                  active && "border-accent bg-accent text-accent-foreground",
                  !done && !active && "border-strong bg-elevated text-muted"
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
              </span>
              <span className="hidden min-w-0 flex-col leading-tight sm:flex">
                <span
                  className={cn(
                    "truncate text-xs font-medium",
                    active || done ? "text-primary" : "text-muted"
                  )}
                >
                  {s.label}
                </span>
                <span className="truncate text-[10px] text-muted">{s.caption}</span>
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px flex-1 transition-colors",
                  i < currentIdx ? "bg-accent/40" : "bg-subtle"
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
