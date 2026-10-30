"use client";

// Projects tutor marks and hands them to a lazy Three.js canvas. The canvas
// stays unmounted until there is something to draw.

import dynamic from "next/dynamic";
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { markVisibleOnSlice, type SketchMark } from "@/lib/sketchMarks";
import type { SketchFrame } from "@/lib/sketchProjection";

const SketchStage = dynamic(() => import("./SketchStage"), { ssr: false });

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
  const [live, setLive] = useState<SketchFrame | null>(frameProp ?? null);
  const frame = frameProp !== undefined ? frameProp : live;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const report = useCallback((next: SketchFrame | null) => {
    onFrameRef.current?.(next);
  }, []);

  useLayoutEffect(() => {
    if (frameProp !== undefined) {
      report(frameProp);
      return;
    }
    const ref = controls;
    if (!ref) return;
    let stop = () => {};
    let current: CornerstoneControls | null = null;
    const attach = () => {
      const next = ref.current;
      if (next === current) return;
      stop();
      current = next;
      if (!next?.subscribeView) {
        setLive(null);
        report(null);
        return;
      }
      stop = next.subscribeView((nextFrame) => {
        setLive(nextFrame);
        report(nextFrame);
      });
    };
    attach();
    const timer = window.setInterval(attach, 240);
    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, [controls, frameProp, report]);

  if (!frame || frame.width < 2 || frame.height < 2) return null;
  const visible = marks.filter((mark) => markVisibleOnSlice(mark, frame.sliceIndex));
  if (visible.length === 0) return null;
  return <SketchStage marks={visible} frame={frame} />;
}
