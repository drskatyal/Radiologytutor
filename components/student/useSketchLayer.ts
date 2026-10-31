"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import type { LiveTeachingPack } from "@/lib/liveTeachingPack";
import {
  isSketchDraw,
  keepWith,
  replaySketches,
  resolveSketchTool,
  type ReplayStep,
  uncertainTapMark,
  type SketchMark,
  type StudentTap,
} from "@/lib/sketchMarks";
import type { HarnessViewerAction } from "@/lib/harness/tools";

function isSketchAction(
  action: HarnessViewerAction
): action is Extract<
  HarnessViewerAction,
  { type: "draw_circle" | "draw_arrow" | "place_card" | "clear_overlay" | "jump_to_key_view" }
> {
  return (
    action.type === "draw_circle" ||
    action.type === "draw_arrow" ||
    action.type === "place_card" ||
    action.type === "clear_overlay" ||
    action.type === "jump_to_key_view"
  );
}

export function useSketchLayer(controls: RefObject<CornerstoneControls | null>) {
  const [marks, setMarks] = useState<SketchMark[]>([]);
  const [tapMark, setTapMark] = useState<SketchMark | null>(null);
  const tapRef = useRef<StudentTap | null>(null);
  const generation = useRef(1);

  const clear = useCallback(() => {
    setMarks([]);
    setTapMark(null);
    tapRef.current = null;
  }, []);

  const clearAuthored = useCallback(() => {
    setMarks([]);
  }, []);

  const noteImagePoint = useCallback((point: { x_pct: number; y_pct: number }, sliceIndex?: number) => {
    if (point.x_pct < -0.02 || point.x_pct > 1.02 || point.y_pct < -0.02 || point.y_pct > 1.02) return;
    const tap: StudentTap = {
      x_pct: Math.min(1, Math.max(0, point.x_pct)),
      y_pct: Math.min(1, Math.max(0, point.y_pct)),
      sliceIndex,
    };
    tapRef.current = tap;
    generation.current += 1;
    setTapMark(uncertainTapMark(tap, generation.current));
  }, []);

  // One confident mark at a time: a new stroke replaces the previous
  // stroke, and another finding's marks leave. A card stays with its
  // finding until a new card replaces it.
  const showMarks = useCallback((next: SketchMark[]) => {
    if (!next.length) return;
    setMarks((prev) => keepWith(prev, next));
  }, []);

  const replay = useCallback((pack: LiveTeachingPack, findingId: string, step: ReplayStep = "all") => {
    generation.current += 1;
    if (step !== "card") {
      setMarks(replaySketches(pack, findingId, generation.current, step));
      return;
    }
    // The card names a lesion that is circled. If the ring was skipped
    // (a check-in answered it), draw both, ring first.
    const gen = generation.current;
    setMarks((prev) =>
      prev.some((mark) => mark.findingId === findingId && mark.kind !== "card")
        ? keepWith(prev, replaySketches(pack, findingId, gen, "card"))
        : replaySketches(pack, findingId, gen, "all")
    );
  }, []);

  const applyTool = useCallback(
    async (
      pack: LiveTeachingPack,
      name: string,
      args: Record<string, unknown>,
      opts?: { spoil?: boolean; currentFindingId?: string }
    ): Promise<{ ok: boolean; error?: string; findingId?: string }> => {
      generation.current += 1;
      const outcome = resolveSketchTool(pack, name, args, {
        currentFindingId: opts?.currentFindingId,
        studentTap: tapRef.current,
        generation: generation.current,
      });
      if (!outcome.ok) return { ok: false, error: outcome.error };
      if (!isSketchDraw(outcome)) {
        clear();
        return { ok: true };
      }
      const view = outcome.keyView;
      const viewer = controls.current;
      if (viewer && view && (view.sliceIndex != null || view.ww != null || view.zoom != null || view.seriesInstanceUID)) {
        if (view.seriesInstanceUID && viewer.seriesUIDs.includes(view.seriesInstanceUID) && viewer.activeSeriesUID !== view.seriesInstanceUID) {
          viewer.showSeries(view.seriesInstanceUID);
          await viewer.settle();
        }
        const state: {
          sliceIndex?: number;
          windowWidth?: number;
          windowCenter?: number;
          zoom?: number;
          pan?: [number, number];
        } = {};
        if (view.sliceIndex != null) state.sliceIndex = view.sliceIndex;
        if (view.ww != null && view.wc != null) {
          state.windowWidth = view.ww;
          state.windowCenter = view.wc;
        }
        if (view.zoom != null) {
          state.zoom = view.zoom;
          if (view.panX != null && view.panY != null) state.pan = [view.panX, view.panY];
        }
        if (Object.keys(state).length) await viewer.showState(state, 520);
      }
      if (outcome.marks.length) showMarks(outcome.marks);
      if (name === "jump_to_key_view" && opts?.spoil && outcome.findingId) replay(pack, outcome.findingId);
      return { ok: true, findingId: outcome.findingId };
    },
    [clear, controls, replay, showMarks]
  );

  const applyAction = useCallback(
    async (pack: LiveTeachingPack, action: HarnessViewerAction, opts?: { spoil?: boolean; currentFindingId?: string }) => {
      if (!isSketchAction(action)) return false;
      const args: Record<string, unknown> = { ...action };
      delete args.type;
      await applyTool(pack, action.type, args, opts);
      return true;
    },
    [applyTool]
  );

  return {
    marks: tapMark ? [...marks, tapMark] : marks,
    clear,
    clearAuthored,
    noteImagePoint,
    showMarks,
    replay,
    applyTool,
    applyAction,
    studentTap: tapRef,
  };
}

