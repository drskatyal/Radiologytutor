"use client";

// A worked example of the teaching-layer seam (lib/teachingLayer.ts), and the
// fixture e2e/visual/teaching-layer.spec.ts drives: the shared ViewerFrame on
// local files with a two-finding tour on top. The marker, the tour bar and the
// landings all go through the layer; the frame itself is untouched.
//
// Not a product surface: RadLearn's CaseViewer moves onto the frame in the
// next step with its real findings. Mounted only at /dev/teaching-layer.

import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui";
import { ViewerFrame } from "@/components/viewer/ViewerFrame";
import {
  tourMove,
  tourPosition,
  type TeachingLayer,
  type TeachingViewer,
  type TourStep,
} from "@/lib/teachingLayer";

interface DemoFinding extends TourStep {
  label: string;
  sliceFraction: number;
  windowWidth: number;
  windowCenter: number;
  marker: { x_pct: number; y_pct: number };
}

const FINDINGS: readonly DemoFinding[] = [
  { id: "f1", order: 1, label: "Lung window", sliceFraction: 0.25, windowWidth: 1500, windowCenter: -600, marker: { x_pct: 0.3, y_pct: 0.45 } },
  { id: "f2", order: 2, label: "Soft tissue", sliceFraction: 0.75, windowWidth: 400, windowCenter: 40, marker: { x_pct: 0.62, y_pct: 0.58 } },
];

export function TeachingLayerDemo() {
  const viewer = useRef<TeachingViewer | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [landing, setLanding] = useState(false);

  const land = useCallback(async (finding: DemoFinding | null) => {
    if (!finding || !viewer.current) return;
    setCurrent(finding.id);
    setLanding(true);
    try {
      await viewer.current.showView(
        { sliceFraction: finding.sliceFraction, windowWidth: finding.windowWidth, windowCenter: finding.windowCenter },
        400
      );
    } finally {
      setLanding(false);
    }
  }, []);

  const shown = FINDINGS.find((f) => f.id === current) ?? null;
  const position = tourPosition(FINDINGS, current);

  // Stable per finding: the frame calls overlay() on every render.
  const teaching = useMemo<TeachingLayer>(
    () => ({
      defaultTool: "StackScroll",
      overlay: (pane) =>
        pane.index === 0 && shown ? (
          <span
            data-testid="teaching-marker"
            aria-label={`Finding marker: ${shown.label}`}
            role="img"
            className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-warning shadow-[0_0_0_2px_rgba(0,0,0,0.6)]"
            // Dynamic: the marker's stored [0,1] position.
            style={{ left: `${shown.marker.x_pct * 100}%`, top: `${shown.marker.y_pct * 100}%` }}
          />
        ) : null,
      onViewer: (v, pane) => {
        if (pane.index !== 0) return;
        viewer.current = v;
        void land(tourMove(FINDINGS, null, 1));
      },
    }),
    [shown, land]
  );

  return (
    <div className="viewer-shell flex h-dvh min-h-0 flex-col bg-vl-bg text-vl-fg">
      <div
        role="toolbar"
        aria-label="Teaching tour"
        className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2"
      >
        <Button
          variant="imaging"
          size="sm"
          disabled={!position?.hasPrev || landing}
          onClick={() => void land(tourMove(FINDINGS, current, -1))}
          aria-label="Previous finding"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <p className="min-w-0 text-sm tabular-nums" data-testid="tour-position" aria-live="polite">
          {position ? `${position.label} · ${position.step.label}` : "Open a study to start the tour"}
        </p>
        <Button
          variant="imaging"
          size="sm"
          disabled={!position?.hasNext || landing}
          onClick={() => void land(tourMove(FINDINGS, current, 1))}
          aria-label="Next finding"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <main className="flex min-h-0 flex-1 flex-col" aria-label="DICOM viewer">
        <ViewerFrame tone="reading" teaching={teaching} />
      </main>
    </div>
  );
}
