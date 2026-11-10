// The teaching layer: the one seam through which RadLearn puts teaching on top
// of the shared viewer (components/viewer/ViewerFrame.tsx).
//
// The FlowRad free viewer and RadLearn render the same reading frame. What
// RadLearn adds — finding markers and overlays, a guided tour that lands the
// viewer on each finding, the tutor's viewer actions, later recording — goes
// through a `TeachingLayer` handed to the frame, never through new props
// threaded into CornerstoneViewer. With no layer the frame is the free viewer.
//
//   features   which reading groups the teaching surface keeps (lib/viewerFeatures);
//              default TEACHING_FEATURES, the cut-down set every RadLearn screen
//              has today.
//   overlay    drawn over each pane's image (CornerstoneViewer's imageOverlay
//              slot: hidden while MPR owns the pane). Markers, the laser, a
//              hit layer for click-the-finding all live here.
//   onViewer   called once a pane's image is up, with a `TeachingViewer`: the
//              narrow, promise-based surface a tour or the tutor drives.
//
// Pure: types and plain functions, no React runtime, no Cornerstone. The
// viewer handle is described structurally (`TeachingControls`), so
// CornerstoneViewer's `CornerstoneControls` satisfies it without this module
// importing a component.

import type { ReactNode } from "react";
import type { CornerstoneViewerState } from "./viewerController";
import type { SketchFrame } from "./sketchProjection";
import { TEACHING_FEATURES, viewerFeatures, type ViewerFeatures } from "./viewerFeatures";

// --- the viewer a teaching layer drives ---------------------------------------

/** The part of CornerstoneViewer's handle a teaching layer may use. */
export interface TeachingControls {
  ready: boolean;
  imageCount: number;
  showState: (state: CornerstoneViewerState, durationMs?: number) => Promise<void>;
  setWindow: (windowWidth: number, windowCenter: number, durationMs?: number) => Promise<void>;
  setInvert: (value: boolean) => void;
  reset: () => void;
  getStartState: () => { sliceIndex: number; ww?: number; wc?: number; zoom?: number; pan?: [number, number] };
  seriesUIDs: string[];
  activeSeriesUID?: string;
  showSeries: (seriesInstanceUID: string) => void;
  clearAnnotations: () => void;
  settle: () => Promise<void>;
  subscribeView?: (listener: (frame: SketchFrame | null) => void) => () => void;
}

/** Where the viewer is, in teaching terms. */
export interface TeachingView {
  sliceIndex: number;
  imageCount: number;
  windowWidth?: number;
  windowCenter?: number;
  zoom?: number;
  seriesInstanceUID: string | null;
}

/**
 * What a tour or the tutor drives. Every move resolves when it has landed, so
 * a script can chain them; every move is a no-op (resolving false) while the
 * pane has no image, so a layer never has to guard against a cold viewer.
 */
export interface TeachingViewer {
  readonly ready: boolean;
  /** The current view, or null while nothing is drawn. */
  view(): TeachingView | null;
  /** Animate to a stored finding view (slice, window, zoom, pan). */
  showView(state: CornerstoneViewerState, durationMs?: number): Promise<boolean>;
  setWindow(windowWidth: number, windowCenter: number, durationMs?: number): Promise<boolean>;
  setInvert(on: boolean): boolean;
  /** Switch series by UID and wait for it to settle; false for a UID this pane does not have. */
  showSeries(seriesInstanceUID: string): Promise<boolean>;
  /** Fit and default window. */
  reset(): boolean;
  /** Remove the viewer's own tool annotations (between findings). */
  clearAnnotations(): boolean;
  /** Image-fraction → canvas mapping, for overlays that follow the image. Returns an unsubscribe. */
  onFrame(listener: (frame: SketchFrame | null) => void): () => void;
}

/**
 * Wrap a live controls getter (a ref read) as a TeachingViewer. The getter is
 * read on every call, so the wrapper stays valid when the viewer remounts on a
 * series change.
 */
export function teachingViewer(get: () => TeachingControls | null | undefined): TeachingViewer {
  const live = () => {
    const c = get();
    return c && c.ready ? c : null;
  };
  return {
    get ready() {
      return live() != null;
    },
    view() {
      const c = live();
      if (!c) return null;
      const s = c.getStartState();
      return {
        sliceIndex: s.sliceIndex,
        imageCount: c.imageCount,
        windowWidth: s.ww,
        windowCenter: s.wc,
        zoom: s.zoom,
        seriesInstanceUID: c.activeSeriesUID ?? null,
      };
    },
    async showView(state, durationMs) {
      const c = live();
      if (!c) return false;
      await c.showState(state, durationMs);
      return true;
    },
    async setWindow(ww, wc, durationMs) {
      const c = live();
      if (!c || !Number.isFinite(ww) || !Number.isFinite(wc) || ww <= 0) return false;
      await c.setWindow(ww, wc, durationMs);
      return true;
    },
    setInvert(on) {
      const c = live();
      if (!c) return false;
      c.setInvert(on);
      return true;
    },
    async showSeries(uid) {
      const c = live();
      if (!c || !c.seriesUIDs.includes(uid)) return false;
      if (c.activeSeriesUID !== uid) {
        c.showSeries(uid);
        await c.settle();
      }
      return true;
    },
    reset() {
      const c = live();
      if (!c) return false;
      c.reset();
      return true;
    },
    clearAnnotations() {
      const c = live();
      if (!c) return false;
      c.clearAnnotations();
      return true;
    },
    onFrame(listener) {
      // Not live(): a layer subscribes once, before or after the first image.
      return get()?.subscribeView?.(listener) ?? (() => {});
    },
  };
}

// --- the guided tour ----------------------------------------------------------

/** One step of a teaching plan: a finding, in authored order. */
export interface TourStep {
  id: string;
  order: number;
}

export interface TourPosition<S extends TourStep = TourStep> {
  /** 0-based index in tour order. */
  index: number;
  total: number;
  step: S;
  /** "Finding 2 of 5". */
  label: string;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Steps in tour order: by `order`, ties kept in the given order. */
export function tourOrder<S extends TourStep>(steps: readonly S[]): S[] {
  return steps
    .map((step, i) => ({ step, i }))
    .sort((a, b) => a.step.order - b.step.order || a.i - b.i)
    .map(({ step }) => step);
}

/** Where `currentId` sits in the tour, or null when it is not a step. */
export function tourPosition<S extends TourStep>(steps: readonly S[], currentId: string | null): TourPosition<S> | null {
  const ordered = tourOrder(steps);
  const index = currentId == null ? -1 : ordered.findIndex((s) => s.id === currentId);
  if (index < 0) return null;
  const total = ordered.length;
  return {
    index,
    total,
    step: ordered[index]!,
    label: `Finding ${index + 1} of ${total}`,
    hasPrev: index > 0,
    hasNext: index < total - 1,
  };
}

/**
 * The step `delta` away from `currentId` (next_in_tour = +1, prev_in_tour =
 * −1), clamped to the ends as the tutor does. With no current step, a move
 * starts the tour at its first step.
 */
export function tourMove<S extends TourStep>(steps: readonly S[], currentId: string | null, delta: number): S | null {
  const ordered = tourOrder(steps);
  if (ordered.length === 0) return null;
  const at = currentId == null ? -1 : ordered.findIndex((s) => s.id === currentId);
  if (at < 0) return ordered[0]!;
  const to = Math.min(ordered.length - 1, Math.max(0, at + Math.trunc(delta)));
  return ordered[to]!;
}

// --- the layer ----------------------------------------------------------------

/** The pane a layer is drawing over or driving. */
export interface TeachingPane {
  /** 0 = the main pane; 1… = the extra panes of a hanging layout. */
  index: number;
  seriesInstanceUID: string | null;
  /** The pane the toolbar and keys follow. */
  active: boolean;
}

export interface TeachingLayer {
  /** Reading groups this surface keeps. Default: TEACHING_FEATURES (all off). */
  features?: Partial<ViewerFeatures>;
  /** The tool a pane opens with. Default: StackScroll, as every teaching screen has. */
  defaultTool?: string;
  /** Drawn over each pane's image. */
  overlay?: (pane: TeachingPane) => ReactNode;
  /** A pane's image is up: the viewer a tour or the tutor drives. */
  onViewer?: (viewer: TeachingViewer, pane: TeachingPane) => void;
  /**
   * A session that already drives the viewer through its own handle refs
   * (record / replay, the tutor's actions) names them here: the frame writes
   * each pane's live handle into the returned ref, as it does into its own.
   */
  bindControls?: (paneIndex: number) => { current: TeachingControls | null } | null;
  /** Pane 0's series changed in the viewer (a pick in the series panel, a tutor's set_series). */
  onSeriesChange?: (seriesInstanceUID: string) => void;
  /**
   * A second pane beside the first, on this series (a compare landing: a
   * prior, another series). Null closes it and the frame returns to one pane.
   */
  compare?: TeachingCompare | null;
  /**
   * A short click or tap on a pane's image (not a drag, not the toolbar), in
   * client pixels. The layer maps it with its own overlay's box.
   */
  onPaneClick?: (pane: TeachingPane, point: { clientX: number; clientY: number }) => void;
  /** Kept reachable while the stage is full screen (the session's microphone). */
  dock?: ReactNode;
}

export interface TeachingCompare {
  seriesInstanceUID: string;
  /** Overlay label of the compare pane. Default "Compare". */
  label?: string;
  /** Overlay label of the first pane while comparing. Default "Current". */
  primaryLabel?: string;
}

/** A pointer that moved less than this between down and up is a click, not a drag. */
export const PANE_CLICK_SLOP_PX = 8;

/** Whether a pointer down → up pair is a click (not a scroll, pan or window drag). */
export function isPaneClick(down: { x: number; y: number } | null, up: { x: number; y: number }): boolean {
  return !!down && Math.hypot(up.x - down.x, up.y - down.y) <= PANE_CLICK_SLOP_PX;
}

/** The reading groups for a frame: the free viewer's with no layer, else the layer's (default all off). */
export function frameFeatures(layer: TeachingLayer | null | undefined, freeViewer: ViewerFeatures): ViewerFeatures {
  if (!layer) return freeViewer;
  return layer.features ? viewerFeatures(layer.features) : TEACHING_FEATURES;
}
