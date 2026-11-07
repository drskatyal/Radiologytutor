"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { SketchFrame } from "@/lib/sketchProjection";

/**
 * The live camera of a Cornerstone viewer as a SketchFrame. Re-attaches when
 * the controls object is replaced (series switch, remount). `fixed` wins
 * when given (fixtures and tests drive their own camera).
 */
export function useViewFrame(
  controls: RefObject<CornerstoneControls | null> | undefined,
  fixed?: SketchFrame | null,
  onFrame?: (frame: SketchFrame | null) => void
): SketchFrame | null {
  const [live, setLive] = useState<SketchFrame | null>(fixed ?? null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useLayoutEffect(() => {
    if (fixed !== undefined) {
      onFrameRef.current?.(fixed);
      return;
    }
    if (!controls) return;
    let stop = () => {};
    let current: CornerstoneControls | null = null;
    const attach = () => {
      const next = controls.current;
      if (next === current) return;
      stop();
      current = next;
      if (!next?.subscribeView) {
        setLive(null);
        onFrameRef.current?.(null);
        return;
      }
      stop = next.subscribeView((frame) => {
        setLive(frame);
        onFrameRef.current?.(frame);
      });
    };
    attach();
    const timer = window.setInterval(attach, 240);
    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, [controls, fixed]);

  return fixed !== undefined ? fixed : live;
}
