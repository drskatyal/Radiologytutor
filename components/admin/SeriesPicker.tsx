"use client";

// A compact, selectable list of series within a study. Clicking a row toggles
// whether the case uses that series; the radio marks the primary series (kept
// first in the case's seriesInstanceUIDs so the viewer opens on it).

import { Badge } from "@/components/ui";
import { cn } from "@/components/ui/cn";

export interface SeriesOption {
  seriesInstanceUID: string;
  label: string;
  modality?: string;
  instanceCount?: number;
}

export function SeriesPicker({
  series,
  selected,
  primary,
  onToggle,
  onSetPrimary,
}: {
  series: SeriesOption[];
  /** UIDs the case uses. */
  selected: string[];
  /** UID of the primary (opens-first) series. */
  primary?: string;
  onToggle: (uid: string) => void;
  onSetPrimary: (uid: string) => void;
}) {
  if (series.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-strong bg-surface/50 px-3 py-4 text-center text-xs text-muted">
        No series detected for this study.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5" role="group" aria-label="Series in study">
      {series.map((s) => {
        const isSelected = selected.includes(s.seriesInstanceUID);
        const isPrimary = primary === s.seriesInstanceUID;
        return (
          <li key={s.seriesInstanceUID}>
            <div
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                isSelected
                  ? "border-accent/40 bg-accent/5"
                  : "border-subtle bg-surface hover:border-strong"
              )}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(s.seriesInstanceUID)}
                  className="h-4 w-4 shrink-0 accent-accent"
                  aria-label={`Use series ${s.label}`}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-primary">
                    {s.label}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-xs tabular-nums text-muted">
                    {s.modality && <span>{s.modality}</span>}
                    {typeof s.instanceCount === "number" && s.instanceCount > 0 && (
                      <span>
                        {s.instanceCount} image{s.instanceCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                </span>
              </label>
              {isSelected &&
                (isPrimary ? (
                  <Badge variant="accent">Primary</Badge>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSetPrimary(s.seriesInstanceUID)}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-secondary transition-colors hover:bg-elevated hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    Set primary
                  </button>
                ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
