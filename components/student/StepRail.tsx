"use client";

// The guided-tour step rail. Shows progress ("Finding 2 of 5"), an animated
// progress bar, prev/next controls, and a jump list of every finding with the
// active step highlighted. Driving the viewer is the parent's job — this rail
// only reports intent (onPrev/onNext/onJump).

import { Badge, Button, cn } from "@/components/ui";
import type { Finding } from "@/lib/types";

export function StepRail({
  findings,
  activeIndex,
  busy,
  onPrev,
  onNext,
  onJump,
}: {
  findings: Finding[];
  /** Index into `findings`, or -1 before the tour starts. */
  activeIndex: number;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
}) {
  const total = findings.length;
  const current = activeIndex < 0 ? 0 : activeIndex + 1;
  const pct = total > 0 ? (current / total) * 100 : 0;
  const atStart = activeIndex <= 0;
  const atEnd = activeIndex >= total - 1;

  return (
    <div className="flex flex-col gap-3 border-b border-subtle p-4">
      <div className="flex items-center justify-between">
        <Badge variant="accent" dot>
          Finding {activeIndex < 0 ? "—" : current} of {total}
        </Badge>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={onPrev}
            disabled={busy || atStart}
            aria-label="Previous finding"
          >
            ← Prev
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={onNext}
            disabled={busy || atEnd}
            aria-label="Next finding"
          >
            Next →
          </Button>
        </div>
      </div>

      {/* Animated progress bar. Width is a truly-dynamic value (inline ok). */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Jump list — every finding, active one highlighted. */}
      <ol className="flex flex-col gap-1">
        {findings.map((f, i) => {
          const active = i === activeIndex;
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onJump(i)}
                disabled={busy}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  active
                    ? "bg-accent/15 text-primary"
                    : "text-secondary hover:bg-elevated hover:text-primary"
                )}
                title={f.label}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "bg-elevated text-muted group-hover:text-secondary"
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
