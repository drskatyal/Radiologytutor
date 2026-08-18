"use client";

import { cn } from "@/components/ui";

export function CourseProgressBar({
  percent,
  label = "Progress",
  className,
}: {
  percent: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-secondary">{label}</span>
        <span className="tabular-nums text-primary">{clamped}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface ring-1 ring-inset ring-subtle"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${clamped}%`}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
