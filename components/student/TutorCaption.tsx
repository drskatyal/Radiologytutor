"use client";

// On-image examiner caption — the viva still teaches when the rail is collapsed.
// Shows the current question / teaching line over the imaging surface.

import { Badge } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { ChatSource } from "./useStudentSession";

export function TutorCaption({
  text,
  stepLabel,
  revealed,
  sources,
}: {
  text: string;
  stepLabel?: string;
  /** True once this finding's marker/diagnosis is on the image. */
  revealed?: boolean;
  sources?: ChatSource[];
}) {
  if (!text.trim()) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-4">
      <div
        className={cn(
          "pointer-events-auto w-full max-w-xl rounded-xl border px-3.5 py-2.5 shadow-lg backdrop-blur",
          "border-strong/50 bg-elevated/90"
        )}
        role="status"
        aria-live="polite"
      >
        <div className="mb-1 flex items-center gap-2">
          {stepLabel && (
            <Badge variant="accent" className="tabular-nums">
              {stepLabel}
            </Badge>
          )}
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
            {revealed ? "Teaching" : "Examiner"}
          </span>
        </div>
        <p className="text-sm leading-snug text-primary">{text}</p>
        {sources && sources.length > 0 && (
          <p className="mt-1.5 truncate text-[10px] text-muted">
            {sources[0].title}
          </p>
        )}
      </div>
    </div>
  );
}
