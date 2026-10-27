"use client";

// SeriesNavigator — the PACS series rail.
//
// A vertical list of the case's series (Pacsbin-style). Each card shows a cover
// thumbnail (the series' middle slice, rendered straight from the WADO-RS proxy),
// modality + description + image count. Clicking a card loads that series into
// the main viewport; the active series is highlighted. Fully keyboard-driven
// (roving list of real <button>s, Up/Down to move, Enter/Space to select).
//
// Design-system only: tokens, lucide icons, calm/dense reading-room look. The
// thumbnail uses a tiny rendered JPEG (96px) from /api/dicomweb so we don't
// stand up a second Cornerstone canvas per series. Covers are withheld until
// the caller says the main image is up (`thumbPending`).

import { useRef, useState } from "react";
import { ImageOff, Layers, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { seriesThumbUrl, type RailEntry } from "@/lib/seriesRail";

function SeriesThumb({ series, active }: { series: RailEntry; active: boolean }) {
  const url = series.thumbPending ? null : seriesThumbUrl(series);
  const [seen, setSeen] = useState(url);
  const [state, setState] = useState<"loading" | "loaded" | "error">(
    url ? "loading" : "error"
  );
  // The cover SOP arrives after the main image. Reset the load state with it
  // or a withheld thumb stays on the broken-image icon.
  if (url !== seen) {
    setSeen(url);
    setState(url ? "loading" : "error");
  }

  return (
    <div
      className={cn(
        "relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-imaging",
        active ? "border-accent/60" : "border-subtle"
      )}
    >
      {url && state !== "error" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="eager"
          className={cn(
            "h-full w-full object-cover transition-opacity duration-200",
            state === "loaded" ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
        />
      )}
      {(series.thumbPending || (url && state === "loading")) && (
        <Loader2
          className="absolute h-4 w-4 animate-spin text-white/80"
          aria-hidden="true"
        />
      )}
      {!series.thumbPending && state === "error" && (
        <ImageOff className="h-5 w-5 text-white/80" aria-hidden="true" />
      )}
    </div>
  );
}

export function SeriesNavigator({
  series,
  activeIndex,
  onSelect,
  loading = false,
  className,
}: {
  series: RailEntry[];
  /** Index of the series currently in the viewport. */
  activeIndex: number;
  /** Load a series into the main viewport (by index). */
  onSelect: (index: number) => void;
  /** Show a skeleton rail while series resolve. */
  loading?: boolean;
  className?: string;
}) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Roving keyboard navigation across the rail.
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = index + 1;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = series.length - 1;
    else return;
    e.preventDefault();
    next = Math.max(0, Math.min(series.length - 1, next));
    itemRefs.current[next]?.focus();
  };

  return (
    <nav
      aria-label="Series"
      className={cn(
        "flex h-full min-h-0 flex-col border-subtle bg-surface",
        className
      )}
    >
      <div className="flex items-center gap-2 border-b border-subtle px-3 py-2.5">
        <Layers className="h-4 w-4 text-muted" aria-hidden="true" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-secondary">
          Series
        </h2>
        {!loading && series.length > 0 && (
          <span className="ml-auto rounded-full bg-elevated px-2 py-0.5 text-[11px] tabular-nums text-muted">
            {series.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <ul className="flex flex-col gap-2" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <li
                key={i}
                className="flex items-center gap-3 rounded-lg border border-subtle bg-elevated/40 p-2"
              >
                <div className="h-14 w-14 shrink-0 animate-pulse rounded-md bg-elevated" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-elevated" />
                  <div className="h-2.5 w-1/2 animate-pulse rounded bg-elevated" />
                </div>
              </li>
            ))}
          </ul>
        ) : series.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <ImageOff className="h-6 w-6 text-muted" aria-hidden="true" />
            <p className="text-xs text-muted">No series available for this case.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {series.map((s, i) => {
              const active = i === activeIndex;
              const title =
                s.description?.trim() ||
                (s.seriesNumber != null ? `Series ${s.seriesNumber}` : "Series");
              return (
                <li key={s.seriesInstanceUID}>
                  <button
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    aria-label={
                      s.countPending
                        ? `${title}${s.modality ? `, ${s.modality}` : ""}, image count loading`
                        : `${title}${s.modality ? `, ${s.modality}` : ""}, ${s.instanceCount} image${s.instanceCount === 1 ? "" : "s"}`
                    }
                    title={title}
                    onClick={() => onSelect(i)}
                    onKeyDown={(e) => onKeyDown(e, i)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                      active
                        ? "border-accent/50 bg-accent/10"
                        : "border-subtle bg-elevated/40 hover:border-strong hover:bg-elevated"
                    )}
                  >
                    <SeriesThumb series={s} active={active} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span
                        className={cn(
                          "truncate text-sm font-medium",
                          active ? "text-primary" : "text-secondary"
                        )}
                      >
                        {title}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted">
                        {s.modality && (
                          <Badge variant={active ? "accent" : "neutral"}>
                            {s.modality}
                          </Badge>
                        )}
                        {s.countPending ? (
                          <span
                            className="inline-block h-2.5 w-12 animate-pulse rounded bg-elevated"
                            aria-hidden="true"
                          />
                        ) : (
                          <span>
                            {s.instanceCount} image{s.instanceCount === 1 ? "" : "s"}
                          </span>
                        )}
                        {s.seriesNumber != null && <span>· #{s.seriesNumber}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
