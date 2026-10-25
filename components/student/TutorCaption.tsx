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
  modeLabel,
  sources,
  className,
}: {
  text: string;
  stepLabel?: string;
  /** True once this finding's marker/diagnosis is on the image. */
  revealed?: boolean;
  /** "Teaching" | "Examiner" etc. */
  modeLabel?: string;
  sources?: ChatSource[];
  className?: string;
}) {
  if (!text.trim()) return null;

  return (
    <div
      className={cn("w-full text-left", className)}
      role="status"
      aria-live="polite"
    >
      <div className="mb-1 flex items-center gap-2">
        {stepLabel && (
          <Badge variant="accent" className="tabular-nums">
            {stepLabel}
          </Badge>
        )}
        <span className="text-xs font-medium uppercase tracking-wide text-secondary">
          {modeLabel ?? (revealed ? "Teaching" : "Examiner")}
        </span>
      </div>
      <p className="line-clamp-3 text-sm leading-relaxed text-primary">{text}</p>
      {sources && sources.length > 0 && (
        <p className="mt-1 truncate text-xs text-secondary">{sources[0].title}</p>
      )}
    </div>
  );
}
