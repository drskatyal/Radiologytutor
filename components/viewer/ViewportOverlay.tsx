"use client";

// DICOM corner text and orientation letters, drawn over the pixels the way a
// PACS draws them: plain light type with a hard shadow, no boxes. Boxes are
// what made the old readout look like an app sitting on the patient.
//
// Content comes from lib/dicomOverlay.ts (an allow-list — no patient fields
// can reach this component). Pointer-transparent: it never steals a drag.

import { cn } from "@/components/ui/cn";
import type { OrientationMarkers, OverlayCorners } from "@/lib/dicomOverlay";

const type =
  "pointer-events-none absolute z-10 select-none text-[11px] font-medium leading-[1.4] tabular-nums text-white/90 sm:text-xs " +
  "[text-shadow:0_0_3px_rgba(0,0,0,1),0_1px_1px_rgba(0,0,0,1)]";

function Lines({ lines, className }: { lines: string[]; className: string }) {
  if (lines.length === 0) return null;
  return (
    // data-imaging-chrome: tutor cards are seated clear of corner text.
    <div data-imaging-chrome className={cn(type, className)}>
      {lines.map((line, i) => (
        // Secondary lines drop first on a phone-width pane.
        <p key={i} className={cn("whitespace-nowrap", i > 0 && "max-sm:hidden")}>
          {line}
        </p>
      ))}
    </div>
  );
}

export function ViewportOverlay({
  corners,
  markers,
  /** Right inset that clears the slice scrollbar. */
  scrollbar = false,
  label,
}: {
  corners: OverlayCorners;
  markers: OrientationMarkers | null;
  scrollbar?: boolean;
  /** Screen-reader summary; the visual text is decorative duplication. */
  label?: string;
}) {
  const right = scrollbar ? "right-7" : "right-2";
  const marker =
    "pointer-events-none absolute z-10 select-none text-xs font-semibold text-white/80 sm:text-sm " +
    "[text-shadow:0_0_3px_rgba(0,0,0,1),0_1px_1px_rgba(0,0,0,1)]";
  return (
    <div className="contents" role={label ? "status" : undefined} aria-label={label}>
      <Lines lines={corners.topLeft} className="imaging-readout left-2 top-2 max-w-[45%] [&>p]:truncate" />
      <Lines lines={corners.topRight} className={cn(right, "top-2 text-right")} />
      <Lines lines={corners.bottomLeft} className="imaging-readout bottom-2 left-2" />
      <Lines lines={corners.bottomRight} className={cn(right, "bottom-2 text-right")} />
      {markers ? (
        <>
          <span aria-hidden="true" data-imaging-chrome className={cn(marker, "left-1/2 top-1.5 -translate-x-1/2")}>
            {markers.top}
          </span>
          <span aria-hidden="true" data-imaging-chrome className={cn(marker, "bottom-1.5 left-1/2 -translate-x-1/2")}>
            {markers.bottom}
          </span>
          <span aria-hidden="true" data-imaging-chrome className={cn(marker, "imaging-readout left-2 top-1/2 -translate-y-1/2")}>
            {markers.left}
          </span>
          <span
            aria-hidden="true"
            data-imaging-chrome
            className={cn(marker, scrollbar ? "right-8" : "right-2", "top-1/2 -translate-y-1/2")}
          >
            {markers.right}
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * Transient on-screen confirmation for a key press or preset ("Lung  W 1500
 * L −600"). The reader's eyes are on the image, not on the toolbar.
 */
export function ViewerHud({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-10 z-20 -translate-x-1/2 animate-overlay-in rounded-md bg-black/80 px-3 py-1.5 text-sm font-medium tabular-nums text-white shadow-lg ring-1 ring-white/10"
    >
      {text}
    </div>
  );
}
