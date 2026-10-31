"use client";

// Follows the live Cornerstone camera and hands the tutor's marks to the ink
// stage. Mounted only while there is ink, so an idle viewer pays nothing.

import { useCallback, useRef, type RefObject } from "react";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { lumaGrid, type Box, type LumaGrid } from "@/lib/cardPlacement";
import type { SketchMark } from "@/lib/sketchMarks";
import type { SketchFrame } from "@/lib/sketchProjection";
import SketchStage from "./SketchStage";
import { useViewFrame } from "./useViewFrame";

export function SketchOverlay({
  marks,
  frame: frameProp,
  controls,
  onFrame,
}: {
  marks: readonly SketchMark[];
  frame?: SketchFrame | null;
  controls?: RefObject<CornerstoneControls | null>;
  onFrame?: (frame: SketchFrame | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frame = useViewFrame(controls, frameProp, onFrame);
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // The rendered slice, read from the viewer's own canvas. Cards sit in the
  // black around the body; without pixels they fall back to geometry.
  const sampleImage = useCallback((): LumaGrid | null => {
    const frame = frameRef.current;
    const root = rootRef.current?.closest("[data-viewer-root]");
    if (!root || !frame) return null;
    // The painted stack canvas is the largest one in the viewer.
    let canvas: HTMLCanvasElement | null = null;
    for (const el of Array.from(root.querySelectorAll("canvas"))) {
      if (!canvas || el.width * el.height > canvas.width * canvas.height) canvas = el;
    }
    if (!canvas || canvas.width < 2 || canvas.height < 2) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const grid = lumaGrid(ctx.getImageData(0, 0, canvas.width, canvas.height), {
      width: frame.width,
      height: frame.height,
    });
    // A blank bitmap would read as all background. Fall back to geometry.
    let peak = 0;
    for (const value of grid.data) peak = Math.max(peak, value);
    return peak > 0.05 ? grid : null;
  }, []);

  // Viewer chrome the card must not cover (toolbar, slice readout,
  // full-screen control), in this overlay's pixels.
  const chromeBoxes = useCallback((): Box[] => {
    const root = rootRef.current;
    if (!root) return [];
    const origin = root.getBoundingClientRect();
    const scope = root.closest("[data-imaging-layout]") ?? root.closest("[data-viewer-root]")?.parentElement ?? document.body;
    const boxes: Box[] = [];
    for (const el of Array.from(scope.querySelectorAll('[role="toolbar"], .imaging-readout, [data-imaging-chrome]'))) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const box = { x: r.left - origin.left - 6, y: r.top - origin.top - 6, width: r.width + 12, height: r.height + 12 };
      const inside = box.x < origin.width && box.y < origin.height && box.x + box.width > 0 && box.y + box.height > 0;
      if (inside) boxes.push(box);
    }
    return boxes;
  }, []);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      {frame && frame.width >= 2 && frame.height >= 2 && marks.length > 0 ? (
        <SketchStage marks={marks} frame={frame} sampleImage={sampleImage} chromeBoxes={chromeBoxes} />
      ) : null}
    </div>
  );
}
