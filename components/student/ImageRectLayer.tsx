"use client";

// A layer the size and position of the displayed image, not the viewport.
// Children that place themselves in [0,1] percentages (the laser, the
// finding marker, measurement handles) then land on the anatomy even when
// the CT is letterboxed, zoomed or panned.

import type { ReactNode, RefObject } from "react";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { useViewFrame } from "./useViewFrame";

export function ImageRectLayer({
  controls,
  children,
}: {
  controls: RefObject<CornerstoneControls | null>;
  children: ReactNode;
}) {
  const frame = useViewFrame(controls);
  const a = frame?.project(0, 0);
  const b = frame?.project(1, 1);
  // Until the first camera frame, fill the viewport (the old behaviour).
  const rect =
    a && b && b.x - a.x > 2 && b.y - a.y > 2
      ? { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }
      : null;
  return (
    <div className={rect ? "pointer-events-none absolute" : "pointer-events-none absolute inset-0"} style={rect ?? undefined}>
      {children}
    </div>
  );
}
