// Compare layout — one Cornerstone rendering engine, and how to repaint the
// primary pane when the split closes.
//
// Cornerstone 5's ContextPool engine allocates a WebGL context pool per
// RenderingEngine (default 7). A second engine for the compare pane pushes
// the page over the browser's context limit; the primary context is lost and
// later renders clear the onscreen canvas to black. Destroying the compare
// engine does not bring that context back. Both panes must hold slots on ONE
// engine id and only the last release may destroy it.
//
// Closing compare also changes the primary element's size. The teach camera
// and lung window live on the viewport and must be reapplied onto the resized
// buffer — Reset view's resetProperties() replaces that window, so the close
// path must not use it.

export const SHARED_RENDERING_ENGINE_ID = "flowrad-engine";

/** Below this the viewport buffer cannot fit an image (Cornerstone's own minimum). */
export const MIN_VIEWPORT_PX = 2;

export function viewportIdFor(instanceId: string): string {
  return `FLOWRAD_STACK_${instanceId}`;
}

export function toolGroupIdFor(instanceId: string): string {
  return `flowrad-tg-${instanceId}`;
}

export interface ViewportSlotPlan {
  holders: string[];
  /** True when this acquire is the first live pane. */
  createEngine: boolean;
}

export function acquireViewportSlot(
  holders: readonly string[],
  instanceId: string
): ViewportSlotPlan {
  if (holders.includes(instanceId)) {
    return { holders: [...holders], createEngine: false };
  }
  return {
    holders: [...holders, instanceId],
    createEngine: holders.length === 0,
  };
}

export interface ViewportReleasePlan {
  holders: string[];
  /** This pane had a slot, so its viewport element should be disabled. */
  disableViewport: boolean;
  /**
   * Destroy the shared engine only when the releasing pane was the last
   * holder. Destroying earlier wipes the primary viewport too.
   */
  destroyEngine: boolean;
}

export function releaseViewportSlot(
  holders: readonly string[],
  instanceId: string
): ViewportReleasePlan {
  const had = holders.includes(instanceId);
  const next = holders.filter((id) => id !== instanceId);
  return {
    holders: next,
    disableViewport: had,
    destroyEngine: had && next.length === 0,
  };
}

/** Module singleton used by the viewer. Tests use the pure functions above. */
export class ViewportEngineRegistry {
  private holders: string[] = [];

  acquire(instanceId: string): ViewportSlotPlan {
    const plan = acquireViewportSlot(this.holders, instanceId);
    this.holders = plan.holders;
    return plan;
  }

  release(instanceId: string): ViewportReleasePlan {
    const plan = releaseViewportSlot(this.holders, instanceId);
    this.holders = plan.holders;
    return plan;
  }

  get size(): number {
    return this.holders.length;
  }
}

export const viewportEngineRegistry = new ViewportEngineRegistry();

export interface ViewPresentation {
  sliceIndex: number;
  zoom?: number;
  pan?: [number, number];
  ww?: number;
  wc?: number;
}

export interface LayoutRestorePlan {
  /** Pass through to RenderingEngine.resize(immediate, keepCamera). */
  keepCamera: boolean;
  /** Fit first, then reapply this camera. Null when the live camera is kept. */
  reapply: { zoom: number; pan: [number, number] } | null;
  ww?: number;
  wc?: number;
  sliceIndex: number;
}

export function presentationCameraUsable(
  presentation: ViewPresentation | null | undefined
): boolean {
  if (!presentation || presentation.zoom == null || !presentation.pan) return false;
  const { zoom, pan } = presentation;
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom > 40) return false;
  const [x, y] = pan;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (Math.abs(x) > 20000 || Math.abs(y) > 20000) return false;
  return true;
}

export function presentationVoi(
  presentation: ViewPresentation | null | undefined
): { ww?: number; wc?: number } {
  if (!presentation || presentation.ww == null || presentation.wc == null) return {};
  if (!Number.isFinite(presentation.ww) || presentation.ww <= 0) return {};
  if (!Number.isFinite(presentation.wc)) return {};
  return { ww: presentation.ww, wc: presentation.wc };
}

/**
 * What to do to the primary viewport when compare closes (or the pane resizes).
 * A finite teach camera is kept. A poisoned camera (NaN zoom/pan, or a 0×0 pane)
 * is fit, then the last good zoom/pan is reapplied. The lung window on the live
 * viewport wins over the snapshot so Reset-style VOI loss cannot blank the study.
 */
export function planViewportLayoutRestore(args: {
  width: number;
  height: number;
  live: ViewPresentation;
  lastGood: ViewPresentation | null;
}): LayoutRestorePlan {
  const sizeOk = args.width >= MIN_VIEWPORT_PX && args.height >= MIN_VIEWPORT_PX;
  const liveCameraOk = sizeOk && presentationCameraUsable(args.live);
  const fallback = presentationCameraUsable(args.lastGood) ? args.lastGood : null;
  const voi =
    presentationVoi(args.live).ww != null
      ? presentationVoi(args.live)
      : presentationVoi(args.lastGood);
  const sliceIndex = Number.isFinite(args.live.sliceIndex)
    ? args.live.sliceIndex
    : args.lastGood && Number.isFinite(args.lastGood.sliceIndex)
      ? args.lastGood.sliceIndex
      : 0;
  return {
    keepCamera: liveCameraOk,
    reapply:
      !liveCameraOk && fallback && fallback.zoom != null && fallback.pan
        ? { zoom: fallback.zoom, pan: fallback.pan }
        : null,
    ww: voi.ww,
    wc: voi.wc,
    sliceIndex,
  };
}
