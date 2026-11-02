"use client";

// Self-hosted Cornerstone3D stack viewer — the "Our Viewer" of FlowRad Learn.
// It owns the full feature set we get from rendering DICOM ourselves: scroll,
// window/level, zoom, pan, native annotations, AND — crucially — programmatic
// driving of the camera/VOI/slice for BOTH:
//   • the guided student walk-through (smoothly INTERPOLATED, via showState), and
//   • exact record → replay (DENSE event re-application, via applyEvent).
//
// Two modes, one component:
//   • Docked chrome (default): tools sit in a bar UNDER the image, grouped the
//     way OHIF's primary toolbar is (navigate / measure / display). Used by
//     /cornerstone, /record and the author capture surface. The bar is outside
//     the square so it never covers anatomy and never sits under the annotate
//     hit-layer.
//   • Edge chrome: student and teach sessions, and the studio stage when the
//     pane fills its parent. The image fills the pane and the same grouped bar
//     sits along its bottom edge — still off the pixels — so a compare layout
//     can give every pane matching chrome.
// Both bars, and the preset / measurement menus, are imaging-dark (#181818,
// #1F1F1F hairline, white labels). Paper surface tokens wash out against the
// black viewport. Active tools use cobalt with white text.
//   • Off: pass `showToolbar={false}` (or `chrome="off"`). The caller still
//     drives the viewport via the imperative handle. A corner readout (slice,
//     window/level) stays — that is viewport state, not a tool.
//
// Mouse: wheel = scroll, right-drag = zoom, middle-drag = pan. The LEFT button
// runs whichever tool is picked in the toolbar (window/level by default).
//
// RECORD/REPLAY: pass `onEvent` to receive an ordered stream of viewer state
// changes (slice / voi / camera / invert / annotation) read straight off the
// viewport — we never trust event-detail shapes. Camera/VOI are throttled
// (~50ms) but order is preserved. Length / ROI / Arrow / Probe / Angle
// strokes emit an `annotation` event when the tool completes.
// `applyEvent` re-applies one recorded event (the replay + teach-guide path).
//
// Must be loaded with `next/dynamic({ ssr:false })` — uses WebGL/DOM/workers.

import { safeErrorText } from "@flowrad/viewer-core/safeLog";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { annotationEditing } from "@flowrad/viewer-core";
import { AnnotationEditLayer } from "./viewer/AnnotationEditLayer";
import type { VoiceState } from "./viewer/voice/voiceSession";
import type { VoiceAction } from "@flowrad/viewer-core";
import createImageIdsAndCacheMetaData from "../lib/createImageIdsAndCacheMetaData";
import {
  prefetchImageIndexes,
  prefetchNeighborImageIds,
  startProgressiveWadorsLoad,
} from "../lib/progressiveStack";
import {
  createScrollDirectionState,
  directionalPrefetchIndexes,
  prefetchRadiusFor,
  trackScrollDirection,
} from "../lib/prefetchPlan";
import {
  coreInitConfig,
  describeRuntime,
  detectDeviceProfile,
  imageCacheBytes,
  retrievalPoolSizes,
  webWorkerCount,
} from "../lib/viewerRuntime";
import { NEIGHBOR_PREFETCH_DELAY_MS, tuneStackScrollTool } from "../lib/scrollSensitivity";
import { fillBudget, outwardOrder } from "../lib/seriesFill";
import { stackOpenIndex } from "../lib/stackIndex";
import type { OpenSlice } from "../lib/viewerLoad";
import {
  beginViewerNavigation,
  markViewerPixels,
  publishSeriesImageCount,
} from "../lib/viewerSession";
import {
  markViewerFirstPixel,
  markViewerFirstPreview,
  markViewerFullQuality,
  markViewerNavigation,
  markViewerSeriesReady,
} from "../lib/viewerTiming";
import {
  QUALITY_EVENT,
  imageSource,
  installBundleLoader,
  isPreviewImage,
  isQualitySwap,
  type CoreLike,
  type DicomLoaderLike,
  type QualityEventDetail,
} from "../lib/dicomCdn/cornerstoneBridge";
import { previewBlocksPress } from "../lib/dicomCdn/previewLock";
import {
  BUNDLED_CASE,
  caseSeriesToSource,
  viewerSourceKey,
  type CaseSeries,
  type ViewerSource,
} from "../lib/viewerSource";
import {
  tween,
  lerp,
  type CornerstoneViewerState,
} from "../lib/viewerController";
import { displaySliceNumber, sopUidFromImageId } from "../lib/findingDisplayState";
import {
  CINE_FPS_OPTIONS,
  advanceCine,
  cineAvailable,
  cineFrameMs,
  clampCineFps,
  createCineState,
  initialCineFps,
  type CineWrap,
} from "../lib/cinePlayer";
import { clampIndex, indexFromPointer, thumbGeometry } from "../lib/sliceScrollbar";
import { isTextTarget, resolveViewerHotkey, type ViewerHotkeyAction } from "../lib/viewerHotkeys";
import {
  OVERLAY_STORAGE_KEY,
  nextOverlayDensity,
  orientationMarkers,
  overlayCorners,
  parseOverlayDensity,
  windowLine,
  type OverlayDensity,
  type OverlayMeta,
} from "../lib/dicomOverlay";
import { voiTransitionMs } from "../lib/voiTransition";
import {
  finiteVoi,
  resolveViewportVoi,
  voiToWwWc,
  voiWriteSteps,
  wwWcToVoi,
  type Voi,
} from "../lib/viewportVoi";
import {
  SHARED_RENDERING_ENGINE_ID,
  planViewportLayoutRestore,
  presentationCameraUsable,
  viewportEngineRegistry,
  viewportIdFor,
  toolGroupIdFor,
  type ViewPresentation,
} from "../lib/compareViewport";
import type { SketchFrame } from "../lib/sketchProjection";
import {
  normalizeMeasurements,
  statsFromAnnotation,
  type RawAnnotationLike,
} from "../lib/findingMeasurements";
import {
  jpegStillFromGrayscale,
  largestCanvas,
  stillFromCanvas,
  type GrayscaleFrame,
} from "../lib/compileMedia";
import {
  annotationViewerEvent,
  sameAnnotationStroke,
} from "../lib/annotationCapture";
import type { FindingMeasurement, RecordedEvent, ViewerEvent } from "../lib/types";
import {
  WINDOW_PRESETS,
  FULL_DYNAMIC_ID,
  presetsForModality,
  type WindowPreset,
} from "../lib/windowPresets";
import { Spinner } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { MprLayout } from "./MprLayout";
import {
  MEASURE_TOOLS,
  PRIMARY_TOOLS,
  ViewerToolbar,
  toolLabel,
} from "./viewer/ViewerToolbar";
import { ViewerHud, ViewportOverlay } from "./viewer/ViewportOverlay";
import { ViewerHelp } from "./viewer/ViewerHelp";
import { SURFACE_PRESETS, type CutAxis } from "@flowrad/viewer-core";
import vtkPlane from "@kitware/vtk.js/Common/DataModel/Plane";
import {
  assessMpr,
  modalityForMpr,
  mprLoadFailureMessage,
  mprVolumeKey,
  nextMprAction,
  planesFromMetadata,
  type MprMode,
  type MprPlane,
  type MprRender,
  type MprSessionHandle,
  type PlaneSample,
} from "../lib/mpr";

// Tools selectable on the LEFT mouse button live in viewer/ViewerToolbar.tsx.
// Pan/Zoom/Scroll also keep their wheel/middle/right bindings so the usual
// PACS mouse scheme still works.
//
// Measurement tools place annotations in world space; only the real-world
// MEASUREMENT (mm vs px) needs per-image PixelSpacing — the tools still DRAW
// correctly without it. So they stay ENABLED by default and are only disabled
// when a study POSITIVELY has no pixel spacing at all (e.g. the tiny synthetic
// multiframe MR we bundle as an offline sample).

/** `dock` — square image, bar underneath (record / demo).
 *  `edge` — image fills the pane, bar along its bottom edge (student).
 *  `off` — no tools. A corner readout still shows slice and window/level. */
export type ViewerChrome = "dock" | "edge" | "off";

function resolveChrome(showToolbar: boolean, chrome?: ViewerChrome): ViewerChrome {
  if (chrome) return chrome;
  return showToolbar ? "dock" : "off";
}

const ANNOTATION_TOOL_NAMES = new Set(
  PRIMARY_TOOLS.filter((t) => t.annotation).map((t) => t.name)
);

// Minimal structural type for the bits of a StackViewport we drive.
interface DrivableViewport {
  setStack: (ids: string[], i?: number) => Promise<void>;
  render: () => void;
  resetCamera: () => void;
  resetProperties?: () => void;
  getImageIds: () => string[];
  getCurrentImageIdIndex: () => number;
  getCurrentImageId?: () => string;
  setImageIdIndex: (i: number) => Promise<void> | void;
  getProperties: () => {
    voiRange?: { lower: number; upper: number };
    invert?: boolean;
    /** False once setProperties has locked the window across slices. */
    isComputedVOI?: boolean;
  };
  setProperties: (p: { voiRange?: { lower: number; upper: number }; invert?: boolean }) => void;
  getZoom: () => number;
  setZoom: (z: number) => void;
  getPan: () => [number, number];
  setPan: (p: [number, number]) => void;
  worldToCanvas?: (p: [number, number, number]) => [number, number];
  canvasToWorld?: (p: [number, number]) => [number, number, number];
  getFrameOfReferenceUID?: () => string;
  getCamera?: () => { viewPlaneNormal?: number[]; viewUp?: number[] };
  element?: HTMLDivElement;
}

/**
 * Imperative handle for driving the viewer. Two complementary paths:
 *   • showState/setWindow — smooth, INTERPOLATED transitions (guided tour).
 *   • applyEvent          — exact re-application of ONE recorded event (replay).
 * Plus the record-side reads (getStartState) and toggles (setInvert).
 */
export interface CornerstoneControls {
  /** Whether the viewer has loaded its series and is drivable. */
  ready: boolean;
  /** Number of slices in the loaded series. */
  imageCount: number;
  /** Animate the viewport to a target view over `durationMs` (default 700). */
  showState: (state: CornerstoneViewerState, durationMs?: number) => Promise<void>;
  /**
   * Adjust window width/center (VOI). Duration auto-adapts unless overridden.
   * Resolves when the tween (or snap) finishes so a teach script can chain moves.
   */
  setWindow: (
    windowWidth: number,
    windowCenter: number,
    durationMs?: number
  ) => Promise<void>;
  /** Set inversion explicitly (record/replay + toolbar). */
  setInvert: (value: boolean) => void;
  /** Reset camera + VOI to the series defaults (fit). */
  reset: () => void;
  /** Fit the image to the pane; keeps the window. (Hanging-layout reflow.) */
  fit?: () => void;
  /**
   * Resize onto the current pane and repaint. Used when compare closes so the
   * primary buffer matches the single-pane layout without dropping the teach
   * window.
   */
  restoreLayout: () => void;
  /** Re-apply ONE recorded event verbatim (the replay path — snaps, no tween). */
  applyEvent: (e: RecordedEvent) => void;
  /** Current slice / VOI / camera / SOP — primes recordings and finding landings. */
  getStartState: () => {
    sliceIndex: number;
    ww?: number;
    wc?: number;
    sopInstanceUID?: string;
    zoom?: number;
    pan?: [number, number];
  };
  /**
   * Snapshot of Length / Ellipse / Probe annotations currently on the
   * viewport — attach to a Finding at save time.
   */
  getMeasurements: () => FindingMeasurement[];
  /** SeriesInstanceUIDs the viewer can switch between (multi-series cases). */
  seriesUIDs: string[];
  /** The SeriesInstanceUID currently shown (undefined for the bundled sample). */
  activeSeriesUID?: string;
  /** Load a different series into the viewport (by UID). Programmatic = replay. */
  showSeries: (seriesInstanceUID: string) => void;
  /** Remove tool annotations (between findings). Does not emit record events. */
  clearAnnotations: () => void;
  /** Resolves when a programmatic slice or series switch has settled. */
  settle: () => Promise<void>;
  /** True when the last annotation applyEvent landed on the viewport. */
  readonly annotationApplied: boolean;
  /**
   * One JPEG of the imaging surface for author compile. Read-only: it does not
   * resize the engine, reset the camera, or touch the compare layout. Returns
   * null when the bitmap is blank and the cached pixels cannot be windowed.
   */
  captureViewportStill?: () => { mimeType: string; base64: string } | null;
  /**
   * MediaStream of the Cornerstone canvas inside this viewport. Never the
   * page, the sidebar, or another panel. Null when the canvas cannot stream.
   */
  captureViewportStream?: () => MediaStream | null;
  /**
   * Image-fraction → canvas pixels for the sketch layer. Fires on camera,
   * slice, and resize. Null while MPR owns the pane.
   */
  subscribeView?: (listener: (frame: SketchFrame | null) => void) => () => void;
}

type CachedSlice = {
  color?: boolean;
  columns?: number;
  rows?: number;
  width?: number;
  height?: number;
  slope?: number;
  intercept?: number;
  invert?: boolean;
  isPreScaled?: boolean;
  photometricInterpretation?: string;
  getPixelData?: () => ArrayLike<number>;
};

/**
 * Prefer the painted canvas (it includes the current zoom). If that bitmap is
 * blank — WebGL often clears the drawing buffer — window the cached slice
 * instead. Neither path resizes the engine or resets the camera.
 */
function grabViewportStill(
  host: HTMLElement | null,
  vp: DrivableViewport | null
): { mimeType: string; base64: string } | null {
  const canvas = host ? largestCanvas(Array.from(host.querySelectorAll("canvas"))) : null;
  if (canvas) {
    const shot = stillFromCanvas(canvas);
    if (shot.ok) return { mimeType: shot.mimeType, base64: shot.base64 };
  }
  if (!vp) return null;
  const image = (
    vp as DrivableViewport & { getCornerstoneImage?: () => CachedSlice | undefined }
  ).getCornerstoneImage?.();
  if (!image || image.color || typeof image.getPixelData !== "function") return null;
  const samples = image.getPixelData();
  const columns = image.columns || image.width || 0;
  const rows = image.rows || image.height || 0;
  if (!samples || columns < 2 || rows < 2 || samples.length < columns * rows) return null;
  const voi = voiToWwWc(vp.getProperties().voiRange);
  if (!voi || !(voi.ww > 1)) return null;
  const preScaled = Boolean(image.isPreScaled);
  const monochrome1 = image.photometricInterpretation === "MONOCHROME1";
  const invert = Boolean(vp.getProperties().invert) !== Boolean(image.invert) !== monochrome1;
  const frame: GrayscaleFrame = {
    columns,
    rows,
    samples,
    slope: preScaled ? 1 : Number(image.slope ?? 1) || 1,
    intercept: preScaled ? 0 : Number(image.intercept ?? 0) || 0,
    ww: voi.ww,
    wc: voi.wc,
    invert,
  };
  return jpegStillFromGrayscale(frame);
}

/** Viewport canvas only. WebGL may still yield blank frames if the buffer is cleared. */
function openViewportStream(host: HTMLElement | null, fps = 12): MediaStream | null {
  const canvas = host ? largestCanvas(Array.from(host.querySelectorAll("canvas"))) : null;
  if (!canvas || typeof canvas.captureStream !== "function") return null;
  try {
    const stream = canvas.captureStream(fps);
    return stream.getVideoTracks().length ? stream : null;
  } catch {
    return null;
  }
}

/**
 * Should the annotation tools be ENABLED for this image?
 *
 * The tools always DRAW; they only need per-image `PixelSpacing` to report a
 * real-world measurement (mm). So we default to enabled and only return false
 * when we POSITIVELY confirm the study has no usable pixel spacing.
 *
 * Cornerstone3D v5's wadors `imagePlaneModule` provider (verified against
 * cornerstone3D/packages/dicomImageLoader/.../wadors/metaData/metaDataProvider.ts)
 * ALWAYS returns an object — never undefined — and sets `usingDefaultValues:true`
 * if ANY of PixelSpacing / ImageOrientationPatient / ImagePositionPatient is
 * absent. The old gate keyed off `usingDefaultValues`, so a real uploaded study
 * that had valid PixelSpacing but no ImagePositionPatient/Orientation got its
 * measure tools wrongly killed. We now ignore that flag and look ONLY at whether
 * pixel spacing is explicitly present-and-zero/invalid.
 *
 * `pixelSpacing` (the raw [row,col] array) is set ONLY when DICOM PixelSpacing
 * was present; when absent the provider leaves it undefined but fills
 * row/columnPixelSpacing with the 1mm default. To avoid a false negative when
 * the provider returns nothing yet (metadata not registered / unknown image),
 * we treat undefined/unknown as ENABLED — only a value we can read AND that is
 * explicitly the missing-spacing default (no `pixelSpacing` array, default 1mm
 * via `usingDefaultValues`) AND has no real spacing disables the tools.
 */
function imageSupportsAnnotation(
  metaData: { get: (type: string, imageId: string) => unknown },
  imageId: string
): boolean {
  try {
    const plane = metaData.get("imagePlaneModule", imageId) as
      | {
          usingDefaultValues?: boolean;
          pixelSpacing?: ArrayLike<number> | null;
          rowPixelSpacing?: number | null;
          columnPixelSpacing?: number | null;
        }
      | undefined;
    // No metadata resolved yet (or no provider answered): assume enabled.
    if (!plane) return true;

    // If the loader exposes the raw DICOM PixelSpacing array, trust it directly:
    // present + positive ⇒ real spacing ⇒ enabled.
    const ps = plane.pixelSpacing;
    if (ps && ps.length >= 2) {
      return Number(ps[0]) > 0 && Number(ps[1]) > 0;
    }

    // No raw array: distinguish "real row/col spacing" from the 1mm default the
    // provider substitutes for missing PixelSpacing. Only positively disable
    // when the spacing IS the substituted default (usingDefaultValues set) — i.e.
    // we know PixelSpacing was absent. Anything else stays enabled.
    if (plane.usingDefaultValues) return false;

    const hasSpacing =
      !!plane.rowPixelSpacing &&
      !!plane.columnPixelSpacing &&
      Number(plane.rowPixelSpacing) > 0 &&
      Number(plane.columnPixelSpacing) > 0;
    // Unknown spacing (no flag, no values) ⇒ assume enabled rather than dead.
    return hasSpacing || (plane.rowPixelSpacing == null && plane.columnPixelSpacing == null);
  } catch {
    // Never let a metadata hiccup kill the tools.
    return true;
  }
}

async function buildImageIds(source: ViewerSource): Promise<string[]> {
  // Local files arrive already resolved: the ids ARE the stack, in order.
  if (source.kind === "imageIds") return [...source.imageIds];
  if (source.kind === "wadouri") {
    // frame index is 1-based in the wadouri imageId (loader subtracts 1).
    return Array.from(
      { length: source.frames },
      (_, i) => `wadouri:${source.url}?frame=${i + 1}`
    );
  }
  return createImageIdsAndCacheMetaData(source);
}

/** One Cornerstone core/tools/loader init per page; see the init effect. */
let engineInit: Promise<void> | null = null;

type EngineModules = {
  core: typeof import("@cornerstonejs/core");
  loader: typeof import("@cornerstonejs/dicom-image-loader");
  tools: typeof import("@cornerstonejs/tools");
  deviceProfile: ReturnType<typeof detectDeviceProfile>;
};
let engineReady: Promise<EngineModules> | null = null;

/**
 * Load and initialise the imaging engine once per page: Cornerstone core,
 * tools, the DICOM loader and its decode-worker pool, the cache ceiling and
 * request pools. Every pane awaits this; a page that is ABOUT to show a viewer
 * (the free viewer's dropzone) calls `prewarmViewerEngine` on idle so the
 * first drop finds the workers already booted.
 */
export function ensureViewerEngine(): Promise<EngineModules> {
  engineReady ??= (async () => {
    const core = await import("@cornerstonejs/core");
    const loader = await import("@cornerstonejs/dicom-image-loader");
    const tools = await import("@cornerstonejs/tools");
    // Engine knobs live in lib/viewerRuntime.ts: how many decode workers,
    // how much decoded-pixel cache, how many frame requests may be in
    // flight, and whether this is a phone (which drops Cornerstone's
    // WebGL context pool from 7 to 1). They are device-dependent and the
    // benchmark harness measures the same functions.
    const deviceProfile = detectDeviceProfile();
    // Once per page, not once per pane. `dicomImageLoader.init()` runs
    // `registerLoaders()`, which PURGES the image cache and the wadors
    // metadata store — so a second pane mounting (a hanging layout, or
    // student compare) silently wiped the first pane's metadata.
    engineInit ??= (async () => {
      await core.init(coreInitConfig(deviceProfile) as Parameters<typeof core.init>[0]);
      await tools.init();
      await loader.init({ maxWebWorkers: webWorkerCount(deviceProfile) });
    })();
    try {
      await engineInit;
    } catch (err) {
      engineInit = null;
      throw err;
    }
    const workers = webWorkerCount(deviceProfile);
    // Converted-bundle delivery (HTJ2K + previews via CDN) behind the same
    // wadors imageIds. Falls through to DICOMweb per image. Idempotent.
    installBundleLoader(
      core as unknown as CoreLike,
      loader as unknown as DicomLoaderLike,
      { decodeWorkers: workers }
    );
    // Cornerstone defaults to 3 GB of decoded pixels, which is a tab kill
    // on a 4 GB laptop or a phone. The cache evicts LRU, so a lower
    // ceiling costs re-decodes, never correctness.
    try {
      core.cache.setMaxCacheSize(imageCacheBytes(deviceProfile));
    } catch {
      /* older core without a settable ceiling — keep the library default */
    }
    const retrieval = (
      core as {
        imageRetrievalPoolManager?: { maxNumRequests?: Record<string, number> };
      }
    ).imageRetrievalPoolManager;
    const pool = retrieval?.maxNumRequests;
    if (pool) Object.assign(pool, retrievalPoolSizes(deviceProfile));
    console.info("[radlearn] viewer runtime", describeRuntime(deviceProfile));
    return { core, loader, tools, deviceProfile };
  })();
  engineReady.catch(() => {
    engineReady = null;
  });
  return engineReady;
}

let contextWarm: Promise<void> | null = null;

/**
 * Fire-and-forget engine warm for idle callbacks: `ensureViewerEngine`, then
 * the shared rendering engine and its first WebGL context. vtk.js creates GL
 * contexts lazily on the first render, and that creation is the single
 * largest cost between "files dropped" and "first pixel" (~50 ms on a GPU,
 * ~250 ms in software GL). One hidden 64 px stack viewport renders once and is
 * disabled again, so the user's viewport finds the context already built.
 * Skipped when a viewer is already mounted.
 */
export function prewarmViewerEngine(): void {
  if (!contextWarm) markEngineWarm("flowrad:viewer:engine-warm-start");
  contextWarm ??= ensureViewerEngine()
    .then(async ({ core }) => {
      markEngineWarm("flowrad:viewer:engine-ready");
      if (viewportEngineRegistry.size > 0) return;
      const engine = await obtainSharedEngine(core as unknown as EngineHost);
      const element = document.createElement("div");
      // DOM API, not JSX: a throwaway off-screen host, never painted.
      element.style.cssText = "position:fixed;left:-10000px;top:0;width:64px;height:64px;";
      element.setAttribute("aria-hidden", "true");
      document.body.appendChild(element);
      const viewportId = "flowrad-context-warm";
      try {
        engine.enableElement({ viewportId, type: core.Enums.ViewportType.STACK, element });
        (engine.getViewport(viewportId) as { render?: () => void } | undefined)?.render?.();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      } finally {
        try {
          engine.disableElement(viewportId);
        } catch {
          /* engine torn down meanwhile */
        }
        element.remove();
        markEngineWarm("flowrad:viewer:engine-warm");
      }
    })
    .catch(() => undefined);
}

/** User Timing marks for the prewarm (timings only; read by the perf gate). */
function markEngineWarm(name: string): void {
  try {
    performance.mark(name);
  } catch {
    /* best-effort */
  }
}

type SharedEngine = {
  enableElement: (entry: {
    viewportId: string;
    type: unknown;
    element: HTMLDivElement;
  }) => void;
  disableElement: (viewportId: string) => void;
  getViewport: (viewportId: string) => unknown;
  resize: (immediate?: boolean, keepCamera?: boolean) => void;
  destroy: () => void;
  hasBeenDestroyed?: boolean;
};

type EngineHost = {
  getRenderingEngine: (id: string) => SharedEngine | undefined;
  RenderingEngine: new (id: string) => unknown;
};

let sharedCore: EngineHost | null = null;
let engineCreate: Promise<void> | null = null;

function liveSharedEngine(core: EngineHost): SharedEngine | null {
  const existing = core.getRenderingEngine(SHARED_RENDERING_ENGINE_ID);
  if (existing && !existing.hasBeenDestroyed) return existing;
  return null;
}

async function obtainSharedEngine(core: EngineHost): Promise<SharedEngine> {
  const found = liveSharedEngine(core);
  if (found) return found;
  if (!engineCreate) {
    engineCreate = Promise.resolve()
      .then(() => {
        if (!liveSharedEngine(core)) new core.RenderingEngine(SHARED_RENDERING_ENGINE_ID);
      })
      .finally(() => {
        engineCreate = null;
      });
  }
  await engineCreate;
  const engine = liveSharedEngine(core);
  if (!engine) throw new Error("RadLearn rendering engine was not created");
  return engine;
}

function destroySharedEngineIfIdle(engine: SharedEngine | null | undefined) {
  if (!engine || engine.hasBeenDestroyed) return;
  if (viewportEngineRegistry.size > 0) return;
  try {
    engine.destroy();
  } catch {
    /* already gone */
  }
}

export default function CornerstoneViewer({
  source = BUNDLED_CASE,
  series,
  activeSeriesIndex = 0,
  onSeriesChange,
  controls,
  showToolbar = true,
  chrome: chromeProp,
  modality,
  onReady,
  onEvent,
  className,
  instanceId = "primary",
  imageOverlay,
  openSlice = null,
  defaultTool = "WindowLevel",
  onViewModeChange,
  questionMarkHelp = false,
  onCycleLayout,
  toolbarHost,
  active = true,
  onActivate,
  initialWindow = null,
  paneLabel,
}: {
  /** "Current" / "Prior" in compare: the first line of the top-left overlay. */
  paneLabel?: string;
  source?: ViewerSource;
  /**
   * Multi-series case rail. When provided, the viewport loads
   * `series[activeSeriesIndex]` and switches (via setStack, no remount) when the
   * index changes. Omit for a single-series caller (uses `source`).
   */
  series?: CaseSeries[];
  /** Index into `series` to display. Ignored when `series` is absent. */
  activeSeriesIndex?: number;
  /** Fired when the ACTIVE series changes (record stream emits a `series` event). */
  onSeriesChange?: (seriesInstanceUID: string) => void;
  /** Pass a ref to receive the imperative drive handle (student/record session). */
  controls?: MutableRefObject<CornerstoneControls | null>;
  /** Hide the demo toolbar/status line (driven/student mode). Ignored when
   *  `chrome` is set. */
  showToolbar?: boolean;
  /**
   * Where tool chrome sits. `dock` — bar under a square image. `edge` — bar
   * along the bottom of a pane that fills its parent (student). `off` — no
   * tools. Defaults from `showToolbar`.
   */
  chrome?: ViewerChrome;
  /** Modality (e.g. "CT") — picks the relevant Window/Level presets. */
  modality?: string;
  /** Fired once the series is loaded and the viewport is drivable. */
  onReady?: (controls: CornerstoneControls) => void;
  /** Record hook: ordered viewer state changes (slice/voi/camera/invert). */
  onEvent?: (e: ViewerEvent) => void;
  /** Wrapper class (the viewer fills it; imaging surface stays pure black). */
  className?: string;
  /**
   * Unique id when more than one Cornerstone stack is on screen (compare
   * layout). Must be stable for the life of the mount. Default "primary".
   */
  instanceId?: string;
  /**
   * Drawn on top of the pixels and under the toolbar (replay laser, annotate
   * hit layer, REC HUD). Keeps those controls on the image when the stage
   * goes fullscreen and the image is no longer a square.
   */
  imageOverlay?: ReactNode;
  /**
   * Slice to show first. The last teacher landing on this series, when the
   * case stored one. Otherwise the stack opens at the middle.
   */
  openSlice?: OpenSlice | null;
  /**
   * Tool that owns left-drag and one-finger drag on mount.
   * Reading rooms pass `StackScroll`. Studio record keeps `WindowLevel`.
   */
  defaultTool?: string;
  /** Stack markers and lasers are in image fractions. Callers hide them in MPR. */
  onViewModeChange?: (mode: MprMode) => void;
  /**
   * `?` opens the viewer's shortcut sheet. Leave off inside the student
   * session, which owns `?` on `window`; the standalone viewer turns it on.
   * H always opens it.
   */
  questionMarkHelp?: boolean;
  /** G cycles the caller's hanging layout. Omit where there is no grid. */
  onCycleLayout?: () => void;
  /**
   * Hanging layouts: the shared toolbar slot under the grid. When set, this
   * pane portals its toolbar there while it is the active pane and renders
   * none of its own, so a 2×2 has one bar that follows focus (OHIF's model;
   * docs/UI_AUDIT.md backlog #7).
   */
  toolbarHost?: HTMLElement | null;
  /** False for a non-focused pane in a grid. */
  active?: boolean;
  /** Pointer down or focus inside this pane. */
  onActivate?: () => void;
  /** Window to open on (a view link). Applied once, after the first pixel. */
  initialWindow?: { ww: number; wc: number } | null;
}) {
  const chrome = resolveChrome(showToolbar, chromeProp);
  const docked = chrome === "dock";
  const edge = chrome === "edge";
  const defaultToolRef = useRef(defaultTool);
  defaultToolRef.current = defaultTool;
  const elementRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  // Stable handles the toolbar uses after init.
  const setLeftToolRef = useRef<(name: string) => void>(() => {});
  const resetRef = useRef<() => void>(() => {});
  const clearRef = useRef<() => void>(() => {});
  const invertRef = useRef<(value?: boolean) => void>(() => {});
  const applyPresetRef = useRef<(p: WindowPreset | null) => void>(() => {});
  // Slice scrollbar, keyboard and cine all drive the stack through one fn.
  // The target is a function of the LIVE index and count read off the
  // viewport, not of React state — the corner readout is throttled to 80 ms
  // and a held arrow key or a 30 fps cine would compute from a stale slice.
  // `silent` suppresses the record stream: a cine sweep is a view aid, not a
  // teaching beat, and 15 slice events a second would swamp a recording.
  const setSliceRef = useRef<
    (to: number | ((current: number, count: number) => number), silent?: boolean) => void
  >(() => {});
  const nudgeZoomRef = useRef<(factor: number) => void>(() => {});
  // Live viewport + the most recent rAF tween cancel fn (so we never overlap).
  const viewportRef = useRef<DrivableViewport | null>(null);
  const cancelTweenRef = useRef<() => void>(() => {});
  // Latest onEvent — stored in a ref so listeners always call the current one.
  const onEventRef = useRef<typeof onEvent>(onEvent);
  onEventRef.current = onEvent;
  const onSeriesChangeRef = useRef<typeof onSeriesChange>(onSeriesChange);
  onSeriesChangeRef.current = onSeriesChange;

  // Multi-series: the live list + the UID currently loaded into the viewport.
  // We keep these in refs so the (single-run) init effect and the imperative
  // handle read the latest list without re-running the engine setup.
  const seriesRef = useRef<CaseSeries[] | undefined>(series);
  seriesRef.current = series;
  // The series index actually loaded into the viewport (vs the requested prop).
  const loadedSeriesIndexRef = useRef<number>(-1);
  // Stable switch-series fn (set after init); switches the stack by index.
  const switchSeriesRef = useRef<(index: number, emit?: boolean) => Promise<void>>(
    async () => {}
  );

  // The source the engine initializes with: the active series when a rail is
  // supplied, else the single `source` prop (back-compat).
  const initialSource: ViewerSource =
    series && series.length > 0
      ? caseSeriesToSource(series[Math.max(0, Math.min(series.length - 1, activeSeriesIndex))])
      : source;
  // Instances the archive reported for a series, when the rail carries it.
  // `startProgressiveWadorsLoad` turns a known count into ONE 1-row QIDO at
  // the middle offset instead of paging the whole SOP list to find a midpoint.
  const instanceCountFor = (seriesInstanceUID: string): number | undefined =>
    seriesRef.current?.find((s) => s.seriesInstanceUID === seriesInstanceUID)?.instanceCount;

  const [status, setStatus] = useState("Initializing viewer…");
  const [activeTool, setActiveTool] = useState(defaultTool || "WindowLevel");
  /** Annotation select / delete / erase / label (AnnotationEditLayer). */
  const [editCtx, setEditCtx] = useState<annotationEditing.EditingContext | null>(null);
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  /**
   * The slice on screen is an 8-bit preview from a converted bundle
   * (lib/dicomCdn). Window/level and measurement wait for the full frame.
   */
  const [previewing, setPreviewing] = useState(false);
  const previewingRef = useRef(false);
  const pressGuardRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  /** True once any frame has been drawn. The loading chip moves off the anatomy. */
  const [painted, setPainted] = useState(false);
  /** Full active stack is still registering after a series change. */
  const [stacking, setStacking] = useState(false);
  const openSliceRef = useRef(openSlice);
  openSliceRef.current = openSlice;
  const [inverted, setInverted] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [readout, setReadout] = useState<{
    slice: number;
    count: number;
    ww?: number;
    wc?: number;
    plane?: string;
    /** Image the metadata below was read from (equality check only). */
    imageId?: string;
    meta?: OverlayMeta;
    zoom?: number;
  } | null>(null);
  // Corner overlay density, remembered per browser. Hydrated after mount so
  // server and first client render agree.
  const [overlay, setOverlay] = useState<OverlayDensity>("full");
  useEffect(() => {
    try {
      setOverlay(parseOverlayDensity(window.localStorage.getItem(OVERLAY_STORAGE_KEY)));
    } catch {
      /* storage blocked — keep the default */
    }
  }, []);
  const cycleOverlay = useCallback(() => {
    setOverlay((current) => {
      const next = nextOverlayDensity(current);
      try {
        window.localStorage.setItem(OVERLAY_STORAGE_KEY, next);
      } catch {
        /* storage blocked — still toggles for this session */
      }
      return next;
    });
  }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  // On-screen confirmation for key presses. Cleared after a beat.
  const [hud, setHud] = useState<string | null>(null);
  const hudTimerRef = useRef(0);
  const flash = useCallback((text: string) => {
    window.clearTimeout(hudTimerRef.current);
    setHud(text);
    hudTimerRef.current = window.setTimeout(() => setHud(null), 1100);
  }, []);
  useEffect(() => () => window.clearTimeout(hudTimerRef.current), []);
  const fitRef = useRef<() => void>(() => {});
  const initialWindowRef = useRef(initialWindow);
  initialWindowRef.current = initialWindow;
  const readoutTimerRef = useRef(0);
  // Whether the annotation tools are enabled. Default ENABLED — we only flip to
  // disabled once we POSITIVELY confirm a study has no pixel spacing (e.g. the
  // bundled sample). This avoids the false-negative that killed the tools on
  // real wadors/uploaded studies before their plane metadata had resolved.
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true);
  const [viewMode, setViewMode] = useState<MprMode>("stack");
  // Thin MPR, MIP slab or 3D once the volume is up (lib/mprSession.ts).
  const [mprRender, setMprRender] = useState<MprRender>("mpr");
  // 3D look and cut plane (shared viewer-core helpers, same as FlowRad Viewer desktop).
  const [surface3d, setSurface3d] = useState<number | null>(null);
  const [cut3d, setCut3d] = useState<{ axis: CutAxis; fraction: number } | null>(null);
  const mprRenderRef = useRef<MprRender>("mpr");
  mprRenderRef.current = mprRender;
  // The plane the reader last touched; arrow keys scroll that one.
  const activePlaneRef = useRef<MprPlane>("axial");
  const [cinePlaying, setCinePlaying] = useState(false);
  const [cineFps, setCineFps] = useState(initialCineFps(null));
  const cineWrap: CineWrap = "loop";
  const cineStateRef = useRef(createCineState(1));
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const [mprLive, setMprLive] = useState(false);
  const [mprLoading, setMprLoading] = useState(false);
  const [mprNotice, setMprNotice] = useState<string | null>(null);
  const destroyToolGroupRef = useRef<(id: string) => void>(() => {});
  const viewModeRef = useRef<MprMode>("stack");
  viewModeRef.current = viewMode;
  const modalityRef = useRef(modality);
  modalityRef.current = modality;
  const mprSessionRef = useRef<MprSessionHandle | null>(null);
  const enterMprRef = useRef<() => Promise<void>>(async () => {});
  const exitMprRef = useRef<() => Promise<void>>(async () => {});
  const axialRef = useRef<HTMLDivElement>(null);
  const volume3dRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);

  const presets = presetsForModality(modality);

  // `source` is often a fresh object with the same study/series (Teach rebuilds
  // the compare descriptor every render). Object identity must not tear the
  // engine down — that reloads the stack at the mid-slice default and strands
  // a secondary landing. Series changes on an existing rail go through
  // switchSeries, which does not change this key.
  const sourceKey = viewerSourceKey(source);

  useEffect(() => {
    let disposed = false;
    let prefetchTimer = 0;
    let detachListeners: () => void = () => {};
    let detachQuality: () => void = () => {};
    let resizeObserver: ResizeObserver | null = null;
    let restoreRaf = 0;
    const viewListeners = new Set<(frame: SketchFrame | null) => void>();
    let viewRaf = 0;
    const viewportId = viewportIdFor(instanceId);
    const toolGroupId = toolGroupIdFor(instanceId);
    // One engine for every pane. A second RenderingEngine allocates another
    // WebGL context pool; opening compare then loses the primary context and
    // the canvas clears to black when the split closes.
    const renderingEngineId = SHARED_RENDERING_ENGINE_ID;
    const loadAbort = { current: new AbortController() };
    // Cornerstone rejects in-flight decodes when strict mode tears the
    // viewport down, and a frame requested before its metadata is registered
    // throws inside the loader pool. Those are not teaching failures. Swallow
    // them so the dev overlay does not sit on the image.
    const onLoaderRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { name?: string; message?: string } | undefined;
      const message = String(reason?.message ?? "");
      if (reason?.name === "AbortError" || message.includes("samplesPerPixel")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("unhandledrejection", onLoaderRejection, true);
    const seriesUidOf = (src: ViewerSource) =>
      src.kind === "wadors" ? src.SeriesInstanceUID : "wadouri";

    (async () => {
      if (started.current || !elementRef.current) return;
      started.current = true;
      viewportEngineRegistry.acquire(instanceId);
      beginViewerNavigation(instanceId);
      let activeNav = markViewerNavigation(seriesUidOf(initialSource));
      let activeSeriesUid = seriesUidOf(initialSource);
      setStatus("Opening slice…");
      setReady(false);
      setPainted(false);
      setStacking(true);
      setReadout(null);
      const earlyJob =
        initialSource.kind === "wadors"
          ? startProgressiveWadorsLoad({
              wadoRsRoot: initialSource.wadoRsRoot,
              studyInstanceUID: initialSource.StudyInstanceUID,
              seriesInstanceUID: initialSource.SeriesInstanceUID,
              open: openSliceRef.current,
              instanceCount: instanceCountFor(initialSource.SeriesInstanceUID),
              signal: loadAbort.current.signal,
            })
          : null;

      try {
        const { core, tools, deviceProfile } = await ensureViewerEngine();
        sharedCore = core as unknown as EngineHost;

        const engine = await obtainSharedEngine(core as unknown as EngineHost);
        if (disposed || !elementRef.current) {
          destroySharedEngineIfIdle(engine);
          return;
        }

        engine.enableElement({
          viewportId,
          type: core.Enums.ViewportType.STACK,
          element: elementRef.current,
        });

        const viewport = engine.getViewport(viewportId) as unknown as DrivableViewport;
        viewportRef.current = viewport;

        // Preview vs full quality of the slice on screen, plus the two open
        // timings (lib/viewerTiming.ts). Reset per navigation.
        let qualityNav = "";
        let previewMarked = false;
        let fullMarked = false;
        const noteQuality = (preview: boolean, source: "bundle" | "dicomweb") => {
          if (previewingRef.current !== preview) {
            previewingRef.current = preview;
            setPreviewing(preview);
          }
          if (qualityNav !== activeNav) {
            qualityNav = activeNav;
            previewMarked = false;
            fullMarked = false;
          }
          if (preview && !previewMarked) {
            previewMarked = true;
            markViewerFirstPreview(activeNav, activeSeriesUid);
          } else if (!preview && !fullMarked) {
            fullMarked = true;
            markViewerFullQuality(activeNav, activeSeriesUid, source);
          }
        };
        const onQuality = (evt: Event) => {
          const detail = (evt as CustomEvent<QualityEventDetail>).detail;
          if (detail) noteQuality(detail.preview, "bundle");
        };
        const onStackImage = (evt: Event) => {
          const image = (evt as CustomEvent<{ image?: unknown }>).detail?.image;
          if (image) noteQuality(isPreviewImage(image), imageSource(image));
        };
        // Attached before the first setStack so the opening preview, and an
        // opening swap that lands before the stack finishes, are both seen.
        const qualityEl = elementRef.current;
        const stackNewImage = core.Enums.Events.STACK_NEW_IMAGE;
        qualityEl.addEventListener(stackNewImage, onStackImage);
        qualityEl.addEventListener(QUALITY_EVENT, onQuality);
        detachQuality = () => {
          qualityEl.removeEventListener(stackNewImage, onStackImage);
          qualityEl.removeEventListener(QUALITY_EVENT, onQuality);
        };


        const {
          addTool,
          ToolGroupManager,
          StackScrollTool,
          ZoomTool,
          PanTool,
          WindowLevelTool,
          LengthTool,
          AngleTool,
          ArrowAnnotateTool,
          RectangleROITool,
          EllipticalROITool,
          ProbeTool,
          annotation,
          Enums: toolsEnums,
        } = tools;

        // Register every tool once, then add them all to the group. Per the
        // Cornerstone3D v5 docs the tool group + viewport must be wired up
        // BEFORE the stack is loaded/rendered so the annotation interaction +
        // SVG layer are in place for the very first interaction.
        [
          WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
          LengthTool, AngleTool, ArrowAnnotateTool,
          RectangleROITool, EllipticalROITool, ProbeTool,
        ].forEach((T) => {
          try {
            addTool(T);
          } catch {
            // Already registered on a sibling viewport (compare layout).
          }
        });

        ToolGroupManager.destroyToolGroup(toolGroupId);
        destroyToolGroupRef.current = (id: string) => {
          try {
            ToolGroupManager.destroyToolGroup(id);
          } catch {
            /* already gone */
          }
        };
        const tg = ToolGroupManager.createToolGroup(toolGroupId);
        if (!tg) throw new Error("could not create tool group");
        [
          WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
          LengthTool, AngleTool, ArrowAnnotateTool,
          RectangleROITool, EllipticalROITool, ProbeTool,
        ].forEach((T) =>
          // Arrows draw without a prompt; labels are edited inline (AnnotationEditLayer).
          tg.addTool(T.toolName, T === ArrowAnnotateTool ? annotationEditing.arrowAnnotateConfig : undefined)
        );
        tg.addViewport(viewportId, renderingEngineId);
        if (elementRef.current) setEditCtx({ core, tools, element: elementRef.current, toolGroupId });

        const { MouseBindings } = toolsEnums;
        // Fixed bindings: wheel = scroll, right-drag = zoom, pinch = zoom,
        // middle = pan. These never move to another tool.
        // One-finger drag follows the selected tool (same as the left button),
        // modelled in lib/toolBindings.ts.
        const touchPrimary = { numTouchPoints: 1 };
        const touchPinch = { numTouchPoints: 2 };
        tg.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Wheel }],
        });
        tg.setToolActive(ZoomTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Secondary }, touchPinch],
        });
        tg.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Auxiliary }],
        });

        // Left (Primary) button: whichever tool is picked in the toolbar.
        //
        // ROOT CAUSE of "annotation tools don't draw": Cornerstone's
        // `setToolActive` MERGES new bindings into a tool's existing ones and
        // never removes them, and `getActiveToolForMouseEvent` returns the
        // FIRST Active tool whose bindings include the pressed button. The old
        // `setLeftTool` only ever ADDED a Primary binding to the newly-selected
        // tool without stripping it from the previously-selected one, so e.g.
        // WindowLevel (added to the group first) kept its Primary binding and
        // kept winning the left button — the annotation tool was "active" but
        // never received the mousedown, so nothing drew. Manipulation tools
        // looked fine only because they also have wheel/right/middle bindings.
        //
        // Fix: track the current left-button tool and, on switch, explicitly
        // remove ONLY the Primary and one-finger bindings from the outgoing
        // tool before giving them to the incoming one. Wheel, right-drag,
        // pinch, and middle-drag stay put.
        // (The same algorithm is modelled + unit-tested in lib/toolBindings.ts.)
        let leftTool: string | null = null;
        const setLeftTool = (name: string) => {
          // Crosshairs exist only on the MPR planes. The stack keeps its own
          // left tool so leaving MPR puts it back.
          if (name === "Crosshairs") {
            if (!mprSessionRef.current) return;
            mprSessionRef.current.setLeftTool(name);
            setActiveTool(name);
            return;
          }
          const primary = { mouseButton: MouseBindings.Primary };
          if (name === "Eraser") {
            // No Cornerstone tool on the left button: the edit layer erases.
            if (leftTool && leftTool !== name) tg.setToolPassive(leftTool, { removeAllBindings: [primary, touchPrimary] });
            leftTool = name;
            setActiveTool(name);
            return;
          }
          if (leftTool && leftTool !== name && leftTool !== "Eraser") {
            // Drop only Primary and one-finger from the outgoing tool. Pan/Zoom/
            // Scroll keep their permanent bindings (and stay active);
            // WindowLevel/annotation tools become passive.
            tg.setToolPassive(leftTool, { removeAllBindings: [primary, touchPrimary] });
          }
          tg.setToolActive(name, { bindings: [primary, touchPrimary] });
          leftTool = name;
          mprSessionRef.current?.setLeftTool(name);
          setActiveTool(name);
        };
        const requested = defaultToolRef.current;
        setLeftTool(requested && requested.length > 0 ? requested : "WindowLevel");
        setLeftToolRef.current = setLeftTool;
        // One slice per detent, and a longer drag per slice. The library
        // otherwise steps on every wheel event and uses a 2px drag floor.
        tuneStackScrollTool(
          (tg as { getToolInstance?: (name: string) => unknown }).getToolInstance?.(
            StackScrollTool.toolName
          )
        );

        // Load a stack into the viewport + (re)run the annotation-tool gate.
        // Reused for the initial series AND every series switch (no remount).
        //
        // The gate decides whether the annotation tools stay enabled. Tools
        // start ENABLED; we only disable when we can POSITIVELY confirm the
        // study has no pixel spacing. Plane metadata may not have resolved yet
        // right after setStack (wadors registers it up-front, but wadouri only
        // parses on first load), so we evaluate now AND re-check once the first
        // image renders — sampling a few imageIds, treating any one with real
        // spacing as proof the study is annotatable. If the active left tool is
        // an annotation tool we're disabling, fall back to Window/Level so we
        // never leave a dead tool selected.
        // Corner readout (slice, W/L). Throttled so a window drag doesn't
        // re-render the chrome on every pointer move — the canvas itself is
        // untouched by this state.
        let lastReadoutAt = 0;
        // Last finite teach camera + window. Layout restore falls back to this
        // when the live camera was measured against a 0×0 pane.
        let lastGood: ViewPresentation | null = null;
        let lastRestoreW = -1;
        let lastRestoreH = -1;
        const rememberPresentation = () => {
          const vp = viewportRef.current;
          const host = elementRef.current;
          if (!vp || !host || host.clientWidth < 2 || host.clientHeight < 2) return;
          let zoom: number | undefined;
          let pan: [number, number] | undefined;
          try {
            zoom = vp.getZoom();
            pan = vp.getPan();
          } catch {
            return;
          }
          const voi = voiToWwWc(vp.getProperties().voiRange);
          const next: ViewPresentation = {
            sliceIndex: vp.getCurrentImageIdIndex(),
            zoom,
            pan,
            ww: voi?.ww,
            wc: voi?.wc,
          };
          if (presentationCameraUsable(next) || (voi != null && voi.ww > 0)) {
            lastGood = next;
          }
        };
        // Stack snapshot while its viewport is disabled for MPR (one less
        // WebGL context). Null in stack mode.
        let mprHeld: {
          imageIds: string[];
          index: number;
          zoom: number;
          pan: [number, number];
          invert: boolean;
          fit: boolean;
        } | null = null;
        let heldVoi: Voi | null = null;
        // Corner-overlay metadata. An allow-list read (lib/dicomOverlay.ts):
        // series and geometry fields only, never a patient module.
        const overlayMetaFor = (imageId: string | undefined): OverlayMeta | undefined => {
          if (!imageId) return undefined;
          try {
            const seriesModule = core.metaData.get("generalSeriesModule", imageId) as
              | { modality?: string; seriesDescription?: string; seriesNumber?: number | string }
              | undefined;
            const plane = core.metaData.get("imagePlaneModule", imageId) as
              | {
                  sliceThickness?: number;
                  sliceLocation?: number;
                  rows?: number;
                  columns?: number;
                  imageOrientationPatient?: number[];
                }
              | undefined;
            return {
              modality: seriesModule?.modality ?? null,
              seriesDescription: seriesModule?.seriesDescription ?? null,
              seriesNumber: seriesModule?.seriesNumber ?? null,
              sliceThickness: plane?.sliceThickness ?? null,
              sliceLocation: plane?.sliceLocation ?? null,
              rows: plane?.rows ?? null,
              columns: plane?.columns ?? null,
              imageOrientationPatient: plane?.imageOrientationPatient ?? null,
            };
          } catch {
            return undefined;
          }
        };
        const sameReadout = (
          prev: typeof readout,
          next: NonNullable<typeof readout>
        ): boolean =>
          !!prev &&
          prev.slice === next.slice &&
          prev.count === next.count &&
          prev.ww === next.ww &&
          prev.wc === next.wc &&
          prev.plane === next.plane &&
          prev.imageId === next.imageId &&
          prev.zoom === next.zoom &&
          (prev.meta != null) === (next.meta != null);
        const publishReadout = () => {
          if (mprHeld) {
            const ww = heldVoi ? Math.round(heldVoi.ww) : undefined;
            const wc = heldVoi ? Math.round(heldVoi.wc) : undefined;
            const slice = displaySliceNumber(mprHeld.index);
            const count = mprHeld.imageIds.length;
            const imageId = mprHeld.imageIds[mprHeld.index];
            const next = {
              slice,
              count,
              ww,
              wc,
              plane: "Axial",
              imageId,
              meta: overlayMetaFor(imageId),
            };
            setReadout((prev) => (sameReadout(prev, next) ? prev : next));
            return;
          }
          const vp = viewportRef.current;
          if (!vp) return;
          const v = voiToWwWc(vp.getProperties().voiRange);
          const count = vp.getImageIds().length;
          const slice = displaySliceNumber(vp.getCurrentImageIdIndex());
          const ww = v ? Math.round(v.ww) : undefined;
          const wc = v ? Math.round(v.wc) : undefined;
          let zoom: number | undefined;
          try {
            const z = vp.getZoom();
            zoom = Number.isFinite(z) && z > 0 ? Math.round(z * 100) / 100 : undefined;
          } catch {
            zoom = undefined;
          }
          const imageId = vp.getCurrentImageId?.() || vp.getImageIds()[vp.getCurrentImageIdIndex()];
          const next = {
            slice,
            count,
            ww,
            wc,
            plane: undefined,
            imageId,
            meta: overlayMetaFor(imageId),
            zoom,
          };
          setReadout((prev) => (sameReadout(prev, next) ? prev : next));
          rememberPresentation();
        };
        const scheduleReadout = () => {
          const now = performance.now();
          const elapsed = now - lastReadoutAt;
          if (elapsed >= 80) {
            lastReadoutAt = now;
            publishReadout();
            return;
          }
          window.clearTimeout(readoutTimerRef.current);
          readoutTimerRef.current = window.setTimeout(() => {
            lastReadoutAt = performance.now();
            publishReadout();
          }, 80 - elapsed);
        };

        const loadStack = async (ids: string[], index?: number): Promise<void> => {
          // Null while MPR has suspended the stack. Do not paint onto the
          // disabled viewport; the volume session owns those image ids.
          const vp = viewportRef.current;
          if (!vp) return;
          const openAt =
            index == null
              ? stackOpenIndex(ids.length)
              : Math.max(0, Math.min(ids.length - 1, Math.round(index)));
          await vp.setStack(ids, openAt);
          vp.render();

          const sampleIds = ids.slice(0, Math.min(ids.length, 4));
          const evaluateAnnotatable = () => {
            const annotatable = sampleIds.some((id) =>
              imageSupportsAnnotation(core.metaData, id)
            );
            setAnnotationsEnabled(annotatable);
            if (!annotatable && leftTool && ANNOTATION_TOOL_NAMES.has(leftTool)) {
              const fallback = defaultToolRef.current;
              setLeftTool(
                fallback && !ANNOTATION_TOOL_NAMES.has(fallback) ? fallback : "WindowLevel"
              );
            }
          };
          evaluateAnnotatable();
          // Re-check once the first frame has loaded + its metadata is parsed.
          const recheckEl = elementRef.current;
          const recheck = () => {
            recheckEl?.removeEventListener(
              core.Enums.Events.IMAGE_RENDERED,
              recheck as EventListener
            );
            evaluateAnnotatable();
          };
          recheckEl?.addEventListener(
            core.Enums.Events.IMAGE_RENDERED,
            recheck as EventListener,
            { once: true }
          );
        };

        const stackIdsRef: { current: string[] } = { current: [] };
        let prefetchCenter = -1;
        const travel = createScrollDirectionState();
        // Two prefetch rules (lib/prefetchPlan.ts), because a reader does two
        // different things:
        //
        //   MOVING  — a handful of slices in the direction of travel, issued
        //     on every slice change at `prefetch` priority. Without this, a
        //     held wheel never lets the pause timer fire and every slice is a
        //     cold round trip; the bench measures 49 → 11 ms/slice at 40 ms RTT.
        //   STOPPED — the wide symmetric window, once, after the scroll
        //     settles. Radius now scales with the series: a 30-slice MR is
        //     warmed whole, a 1200-slice CTA stays a window.
        const prefetchTravel = (index: number) => {
          const ids = stackIdsRef.current;
          if (disposed || ids.length === 0) return;
          const direction = trackScrollDirection(travel, index);
          prefetchImageIndexes(ids, directionalPrefetchIndexes(ids.length, index, direction));
        };
        const prefetchAround = (index: number) => {
          prefetchTravel(index);
          window.clearTimeout(prefetchTimer);
          prefetchTimer = window.setTimeout(() => {
            if (disposed || stackIdsRef.current.length === 0 || index === prefetchCenter) return;
            prefetchCenter = index;
            prefetchNeighborImageIds(
              stackIdsRef.current,
              index,
              prefetchRadiusFor(stackIdsRef.current.length)
            );
          }, NEIGHBOR_PREFETCH_DELAY_MS);
        };
        // Whole-series background fill (lib/seriesFill.ts): once per series,
        // outward from the opening slice, at prefetch priority, bounded by the
        // decoded cache. Never re-centred by clearing the queue — a cleared
        // request leaves its image load object pending in Cornerstone's cache
        // forever, and that slice would never paint.
        const filledSeries = new Set<string>();
        const startSeriesFill = (seriesUID: string, center: number) => {
          const ids = stackIdsRef.current;
          if (disposed || ids.length < 2 || filledSeries.has(seriesUID)) return;
          filledSeries.add(seriesUID);
          let bytesPerSlice = 512 * 512 * 2;
          try {
            const px = core.metaData.get("imagePixelModule", ids[center] ?? ids[0] ?? "") as
              | { rows?: number; columns?: number; bitsAllocated?: number; samplesPerPixel?: number }
              | undefined;
            if (px?.rows && px?.columns) {
              bytesPerSlice =
                px.rows * px.columns * Math.max(1, (px.bitsAllocated ?? 16) / 8) * (px.samplesPerPixel ?? 1);
            }
          } catch {
            /* keep the 512² estimate */
          }
          const budget = fillBudget(ids.length, bytesPerSlice, imageCacheBytes(deviceProfile));
          prefetchImageIndexes(ids, outwardOrder(ids.length, center, budget));
        };
        let pixelMarked = false;
        // Mark first pixel only after setStack resolves. IMAGE_RENDERED also
        // fires for an empty enable/resize, and treating that as paint hid
        // the center status and left a black viewport labeled "Loading stack…".
        const noteFirstPixel = (seriesUID: string) => {
          if (pixelMarked || disposed) return;
          const vp = viewportRef.current;
          const imageId = vp?.getCurrentImageId?.() ?? "";
          if (vp?.getCurrentImageId && !imageId) return;
          pixelMarked = true;
          markViewerFirstPixel(activeNav, seriesUID);
          markViewerPixels(instanceId);
          setPainted(true);
          setStatus((prev) => (prev.startsWith("Error") ? prev : "Loading stack…"));
        };
        const finishStack = (seriesUID: string, ids: string[], openIndex: number) => {
          stackIdsRef.current = ids;
          // A cardiac loop authored at 30 fps should play at 30, not at our
          // default. CineRate (0018,0040) when the series carries one.
          try {
            const cine = core.metaData.get("cineModule", ids[openIndex] ?? ids[0] ?? "") as
              | { cineRate?: unknown }
              | undefined;
            const rate = Number(cine?.cineRate);
            setCineFps(initialCineFps(Number.isFinite(rate) && rate > 0 ? rate : null));
          } catch {
            /* no cine module on this series — keep the default rate */
          }
          prefetchCenter = -1;
          publishSeriesImageCount(seriesUID, ids.length);
          markViewerSeriesReady(activeNav, seriesUID, ids.length);
          prefetchAround(openIndex);
          // The ±10 neighbours queue first; the fill follows them.
          window.setTimeout(() => startSeriesFill(seriesUID, openIndex), NEIGHBOR_PREFETCH_DELAY_MS);
          setStacking(false);
          setStatus(`${ids.length} image${ids.length === 1 ? "" : "s"} loaded`);
        };
        const loadPrepared = async (
          job: ReturnType<typeof startProgressiveWadorsLoad>,
          seriesUID: string,
          signal: AbortSignal
        ): Promise<string[] | null> => {
          const box: { full: { imageIds: string[]; openIndex: number } | null } = { full: null };
          const fullReady = job.full.then((value) => {
            box.full = value;
            return value;
          });
          void fullReady.catch(() => undefined);
          const openingId = await job.opening;
          if (disposed || signal.aborted) {
            job.releaseMetadata();
            return null;
          }
          try {
            if (box.full) {
              await loadStack(box.full.imageIds, box.full.openIndex);
              if (disposed || signal.aborted) return null;
              noteFirstPixel(seriesUID);
              finishStack(seriesUID, box.full.imageIds, box.full.openIndex);
              return box.full.imageIds;
            }
            await loadStack([openingId], 0);
            if (disposed || signal.aborted) return null;
            noteFirstPixel(seriesUID);
          } finally {
            // setStack has requested the opening frame. The series metadata
            // document is allowed to start now, and not before.
            job.releaseMetadata();
          }
          const full = await fullReady;
          if (disposed || signal.aborted) return null;
          await loadStack(full.imageIds, full.openIndex);
          if (disposed || signal.aborted) return null;
          finishStack(seriesUID, full.imageIds, full.openIndex);
          return full.imageIds;
        };

        let imageIds: string[] = [];
        if (initialSource.kind === "wadors") {
          const job =
            earlyJob ??
            startProgressiveWadorsLoad({
              wadoRsRoot: initialSource.wadoRsRoot,
              studyInstanceUID: initialSource.StudyInstanceUID,
              seriesInstanceUID: initialSource.SeriesInstanceUID,
              open: openSliceRef.current,
              instanceCount: instanceCountFor(initialSource.SeriesInstanceUID),
              signal: loadAbort.current.signal,
            });
          const ids = await loadPrepared(
            job,
            initialSource.SeriesInstanceUID,
            loadAbort.current.signal
          );
          if (!ids || disposed || !elementRef.current) return;
          imageIds = ids;
        } else if (initialSource.kind === "imageIds" && initialSource.full) {
          // Progressive local open: paint what is parsed, then swap to the
          // ordered stack in place once every header is in.
          const seriesUID = seriesUidOf(initialSource);
          await loadStack([...initialSource.imageIds], 0);
          if (disposed || !elementRef.current) return;
          noteFirstPixel(seriesUID);
          const full = await initialSource.full.catch(() => null);
          if (disposed || !elementRef.current) return;
          imageIds = full && full.imageIds.length > 0 ? full.imageIds : [...initialSource.imageIds];
          const openAt = full ? full.openIndex : 0;
          await loadStack(imageIds, openAt);
          if (disposed || !elementRef.current) return;
          finishStack(seriesUID, imageIds, openAt);
        } else {
          imageIds = await buildImageIds(initialSource);
          if (disposed || !elementRef.current) return;
          const openAt = stackOpenIndex(imageIds.length);
          await loadStack(imageIds, openAt);
          if (disposed || !elementRef.current) return;
          noteFirstPixel(seriesUidOf(initialSource));
          finishStack(seriesUidOf(initialSource), imageIds, openAt);
        }
        viewportRef.current = viewport;
        publishReadout();
        // Record which series is loaded so switches no-op on the active one.
        loadedSeriesIndexRef.current = seriesRef.current ? activeSeriesIndex : -1;

        // --- Record: emit ordered viewer state changes ----------------------
        // We read CURRENT values off the viewport in the handler (never trust
        // the event-detail shape across Cornerstone versions). Camera/VOI are
        // throttled ~50ms; order is preserved (latest value wins per window).
        // Programmatic applyEvent / setWindow bumps suppressDepth so a replay
        // or teach script does not echo back into a recording.
        let suppressDepth = 0;
        const beginSuppress = () => {
          suppressDepth += 1;
        };
        const endSuppress = () => {
          suppressDepth = Math.max(0, suppressDepth - 1);
        };
        const suppressed = () => suppressDepth > 0;
        const emit = (e: ViewerEvent) => {
          if (suppressed()) return;
          onEventRef.current?.(e);
        };
        let pending: Promise<void> = Promise.resolve();
        const chain = (fn: () => Promise<void> | void) => {
          pending = pending.then(() => fn()).then(
            () => undefined,
            () => undefined
          );
        };
        let annotationApplied = false;
        let settleWindow: (() => void) | null = null;
        // Last window a teach beat, preset, or the user asked for. A slice
        // load applies the DICOM window (W 400 / L 40 on this chest CT) unless
        // we put this back after the image is on screen.
        let pinnedVoi: Voi | null = null;
        let layoutGen = 0;

        const writeVoi = (ww: number, wc: number): boolean => {
          const wanted = finiteVoi(ww, wc);
          if (!wanted) return false;
          const vp = viewportRef.current;
          let wrote = false;
          if (vp) {
            const props = vp.getProperties();
            const steps = voiWriteSteps(props.voiRange, wanted.ww, wanted.wc, {
              locked: props.isComputedVOI === false,
            });
            if (steps.length > 0) {
              beginSuppress();
              try {
                for (const voiRange of steps) vp.setProperties({ voiRange });
                vp.render();
              } catch {
                return false;
              } finally {
                endSuppress();
              }
            }
            const live = voiToWwWc(vp.getProperties().voiRange);
            wrote =
              live != null &&
              Math.abs(live.ww - wanted.ww) <= 1 &&
              Math.abs(live.wc - wanted.wc) <= 1;
          }
          if (mprSessionRef.current) {
            mprSessionRef.current.setVoi(wanted.ww, wanted.wc);
            heldVoi = wanted;
            wrote = true;
          } else if (mprHeld) {
            heldVoi = wanted;
            wrote = true;
          }
          publishReadout();
          return wrote;
        };

        const pinVoi = (ww: number, wc: number) => {
          const next = finiteVoi(ww, wc);
          if (!next) return;
          pinnedVoi = next;
          if (mprHeld) heldVoi = next;
        };

        const applyPinnedVoi = () => {
          const wanted = pinnedVoi;
          if (!wanted) return;
          if (writeVoi(wanted.ww, wanted.wc)) return;
          // The actor is missing mid slice-swap. Retry once it is back.
          requestAnimationFrame(() => {
            if (pinnedVoi === wanted) writeVoi(wanted.ww, wanted.wc);
          });
        };

        const releasePinnedVoi = () => {
          pinnedVoi = null;
          layoutGen += 1;
        };

        let lastCamEmit = 0;
        let lastVoiEmit = 0;
        const THROTTLE = 50;

        const readProjector = (): SketchFrame | null => {
          if (mprSessionRef.current) return null;
          const vp = viewportRef.current;
          const host = elementRef.current;
          if (!vp || !host) return null;
          const canvas = host.querySelector("canvas");
          const width = canvas?.clientWidth || host.clientWidth || 0;
          const height = canvas?.clientHeight || host.clientHeight || 0;
          if (width < 2 || height < 2) return null;
          let sliceIndex = 0;
          try {
            sliceIndex = vp.getCurrentImageIdIndex();
          } catch {
            sliceIndex = 0;
          }
          const imageData = (
            vp as DrivableViewport & {
              getImageData?: () => {
                dimensions?: number[];
                imageData?: {
                  indexToWorld?: (ijk: number[], out?: number[]) => number[] | undefined;
                  worldToIndex?: (world: number[], out?: number[]) => number[] | undefined;
                };
              };
            }
          ).getImageData?.();
          const dims = imageData?.dimensions;
          const vtk = imageData?.imageData;
          const asPoint = (value: unknown): number[] | null => {
            if (!value || typeof value !== "object") return null;
            const arr = Array.from(value as ArrayLike<number>);
            if (arr.length < 2 || arr.some((n) => !Number.isFinite(n))) return null;
            return arr;
          };
          const project = (xPct: number, yPct: number) => {
            if (!dims || dims[0] < 2 || dims[1] < 2 || typeof vtk?.indexToWorld !== "function" || typeof vp.worldToCanvas !== "function") {
              return null;
            }
            try {
              const out = [0, 0, 0];
              const returned = vtk.indexToWorld([xPct * (dims[0] - 1), yPct * (dims[1] - 1), 0], out);
              const world = asPoint(returned) ?? asPoint(out);
              if (!world || world.length < 3) return null;
              const [cx, cy] = vp.worldToCanvas(world as [number, number, number]);
              if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
              return { x: cx, y: cy };
            } catch {
              return null;
            }
          };
          const unproject = (x: number, y: number) => {
            if (!dims || dims[0] < 2 || dims[1] < 2 || typeof vtk?.worldToIndex !== "function" || typeof vp.canvasToWorld !== "function") {
              return null;
            }
            try {
              const world = vp.canvasToWorld([x, y]);
              const out = [0, 0, 0];
              const returned = vtk.worldToIndex(world, out);
              const ijk = asPoint(returned) ?? asPoint(out);
              if (!ijk) return null;
              const x_pct = ijk[0]! / (dims[0] - 1);
              const y_pct = ijk[1]! / (dims[1] - 1);
              if (!Number.isFinite(x_pct) || !Number.isFinite(y_pct)) return null;
              return { x_pct, y_pct };
            } catch {
              return null;
            }
          };
          return { sliceIndex, width, height, project, unproject };
        };
        const publishView = () => {
          if (viewRaf) return;
          viewRaf = requestAnimationFrame(() => {
            viewRaf = 0;
            if (viewListeners.size === 0) return;
            const frame = readProjector();
            for (const listener of viewListeners) listener(frame);
          });
        };
        // While a stack is being put back, the image's own window fires
        // VOI_MODIFIED. That is not a user drag and must not replace the
        // window the user set on the MPR planes.
        let pinLocked = false;

        const emitSlice = () => {
          // Overlays (tutor ink, laser) follow the slice, swap or not.
          publishView();
          // The bridge swapped a preview for its full frame in place. Same
          // slice, same camera — not a navigation, so nothing to record.
          if (isQualitySwap()) return;
          const vp = viewportRef.current;
          if (!vp) return;
          rememberPresentation();
          const index = vp.getCurrentImageIdIndex();
          emit({ type: "slice", index });
          prefetchAround(index);
          scheduleReadout();
          // STACK_NEW_IMAGE runs after Cornerstone writes the image window,
          // and a per-image default can write again before this stack yields.
          // Reapply on a microtask so the teach window is the last writer.
          if (pinnedVoi) queueMicrotask(applyPinnedVoi);
        };
        const emitVoi = () => {
          const vp = viewportRef.current;
          if (!vp) return;
          rememberPresentation();
          scheduleReadout();
          const v = voiToWwWc(vp.getProperties().voiRange);
          // A drag on the window tool replaces the teach window. Programmatic
          // writes are suppressed and must not pin a mid-tween value.
          if (v && !suppressed() && !pinLocked) pinnedVoi = { ww: v.ww, wc: v.wc };
          const now = performance.now();
          if (now - lastVoiEmit < THROTTLE) return;
          lastVoiEmit = now;
          if (v) emit({ type: "voi", ww: v.ww, wc: v.wc });
        };
        const emitCamera = () => {
          publishView();
          const vp = viewportRef.current;
          if (!vp) return;
          rememberPresentation();
          scheduleReadout();
          const now = performance.now();
          if (now - lastCamEmit < THROTTLE) return;
          lastCamEmit = now;
          emit({ type: "camera", zoom: vp.getZoom(), pan: vp.getPan() });
        };

        const el = elementRef.current;
        const csEvents = core.Enums.Events;
        const stackEvt = csEvents.STACK_NEW_IMAGE;
        const voiEvt = csEvents.VOI_MODIFIED;
        const camEvt = csEvents.CAMERA_MODIFIED;
        // Length / ROI / Arrow / Probe / Angle → one annotation event per stroke.
        // COMPLETED and the trailing MODIFIED are debounced and de-duplicated.
        const annTimers = new Map<string, number>();
        let lastStroke: Extract<ViewerEvent, { type: "annotation" }> | null = null;
        const normalizedHandles = (raw: RawAnnotationLike): Array<[number, number]> => {
          const vp = viewportRef.current;
          const host = elementRef.current;
          if (!vp || !host || typeof vp.worldToCanvas !== "function") return [];
          const points = raw.data?.handles?.points ?? [];
          const canvas = host.querySelector("canvas");
          const w = canvas?.clientWidth || host.clientWidth || 1;
          const h = canvas?.clientHeight || host.clientHeight || 1;
          const out: Array<[number, number]> = [];
          for (const pt of points) {
            if (!Array.isArray(pt) || pt.length < 2) continue;
            try {
              const [cx, cy] = vp.worldToCanvas(pt as [number, number, number]);
              if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
              out.push([
                Math.min(1, Math.max(0, cx / w)),
                Math.min(1, Math.max(0, cy / h)),
              ]);
            } catch {
              /* point not on this camera */
            }
          }
          return out;
        };
        const emitAnnotationFrom = (raw: RawAnnotationLike | undefined) => {
          if (!raw || suppressed()) return;
          const tool = raw.metadata?.toolName;
          if (tool && !ANNOTATION_TOOL_NAMES.has(tool)) return;
          const handles = normalizedHandles(raw);
          const stats = statsFromAnnotation(raw);
          const event = annotationViewerEvent({
            tool,
            handles,
            sliceIndex: viewportRef.current?.getCurrentImageIdIndex(),
            annotationUID: raw.annotationUID,
            label: stats.label,
            lengthMm: stats.lengthMm,
            meanHu: stats.meanHu,
            maxHu: stats.maxHu,
            minHu: stats.minHu,
            stdHu: stats.stdHu,
            areaMm2: stats.areaMm2,
            unit: stats.unit,
          });
          if (!event) return;
          if (lastStroke && sameAnnotationStroke(lastStroke, event)) return;
          lastStroke = event;
          emit(event);
        };
        const onAnnotationEvent = (evt: Event) => {
          if (suppressed()) return;
          const detail = (evt as CustomEvent).detail as
            | { annotation?: RawAnnotationLike }
            | RawAnnotationLike
            | undefined;
          const raw =
            detail &&
            typeof detail === "object" &&
            "annotation" in detail &&
            detail.annotation
              ? detail.annotation
              : (detail as RawAnnotationLike | undefined);
          const uid = raw?.annotationUID || raw?.metadata?.toolName || "ann";
          const prev = annTimers.get(uid);
          if (prev) window.clearTimeout(prev);
          annTimers.set(
            uid,
            window.setTimeout(() => {
              annTimers.delete(uid);
              emitAnnotationFrom(raw);
            }, 80)
          );
        };
        const toolEventNames = toolsEnums.Events as {
          ANNOTATION_COMPLETED?: string;
          ANNOTATION_MODIFIED?: string;
        };
        const annCompleted =
          toolEventNames?.ANNOTATION_COMPLETED ||
          "CORNERSTONE_TOOLS_ANNOTATION_COMPLETED";
        const annModified =
          toolEventNames?.ANNOTATION_MODIFIED ||
          "CORNERSTONE_TOOLS_ANNOTATION_MODIFIED";

        el.addEventListener(stackEvt, emitSlice as EventListener);
        el.addEventListener(voiEvt, emitVoi as EventListener);
        el.addEventListener(camEvt, emitCamera as EventListener);
        el.addEventListener(annCompleted, onAnnotationEvent as EventListener);
        el.addEventListener(annModified, onAnnotationEvent as EventListener);
        detachListeners = () => {
          el.removeEventListener(stackEvt, emitSlice as EventListener);
          el.removeEventListener(voiEvt, emitVoi as EventListener);
          el.removeEventListener(camEvt, emitCamera as EventListener);
          el.removeEventListener(annCompleted, onAnnotationEvent as EventListener);
          el.removeEventListener(annModified, onAnnotationEvent as EventListener);
          annTimers.forEach((id) => window.clearTimeout(id));
          annTimers.clear();
        };

        // --- Multi-series switching (no remount) ----------------------------
        // Build the target series' imageIds and swap the stack in place. Both a
        // user-driven switch and a programmatic one (replay/applyEvent) notify
        // the parent so the navigator highlight always tracks the live series;
        // only a USER switch emits a `series` record event (a programmatic one
        // would echo into the recording). Switches are serialized so a fast
        // clicker never interleaves stacks.
        const readMeta = (type: string, imageId: string) => core.metaData.get(type, imageId);
        const assessIds = (ids: string[]) => {
          const { planes, dicomModality } = planesFromMetadata(readMeta, ids);
          const seriesModality =
            seriesRef.current?.[loadedSeriesIndexRef.current]?.modality;
          return assessMpr(planes, {
            modality: modalityForMpr(dicomModality, seriesModality, modalityRef.current),
          });
        };
        // WADO-RS registers plane metadata up front, so this is a no-op and
        // does not touch stack time-to-first-pixel. wadouri only parses a
        // frame once it has been fetched; reconstruction needs every slice's
        // position, so those missing frames are read here, on entering MPR.
        const warmPlaneMetadata = async (ids: string[]) => {
          const missing = ids.filter((id) => {
            try {
              return !core.metaData.get("imagePlaneModule", id);
            } catch {
              return true;
            }
          });
          if (!missing.length) return;
          let cursor = 0;
          const width = Math.min(4, missing.length);
          await Promise.all(
            Array.from({ length: width }, async () => {
              while (cursor < missing.length) {
                const id = missing[cursor++];
                try {
                  await core.imageLoader.loadAndCacheImage(id, {
                    priority: -5,
                    requestType: "prefetch",
                  });
                } catch {
                  /* assessment explains a slice we still cannot place */
                }
              }
            })
          );
        };
        const currentIds = () =>
          mprHeld?.imageIds?.length
            ? mprHeld.imageIds
            : viewportRef.current?.getImageIds() ?? [];

        const suspendStack = () => {
          const vp = viewportRef.current;
          if (!vp || mprHeld) return;
          let zoom = 1;
          let pan: [number, number] = [0, 0];
          try {
            zoom = vp.getZoom();
            pan = vp.getPan();
          } catch {
            /* keep the fit camera */
          }
          const voi = voiToWwWc(vp.getProperties().voiRange);
          mprHeld = {
            imageIds: vp.getImageIds().slice(),
            index: vp.getCurrentImageIdIndex(),
            zoom,
            pan,
            invert: Boolean(vp.getProperties().invert),
            fit: false,
          };
          if (!heldVoi && voi) heldVoi = pinnedVoi ?? voi;
          try {
            tg.removeViewports(renderingEngineId, viewportId);
          } catch {
            /* already detached */
          }
          try {
            engine.disableElement(viewportId);
          } catch {
            /* already disabled */
          }
          // disableElement stops rendering but leaves the stack's canvas (and
          // its backing store) in the DOM, hidden behind the MPR planes — a
          // full-size blank viewport the GPU kept around. resumeStack's
          // enableElement rebuilds it.
          elementRef.current?.querySelectorAll(".viewport-element").forEach((node) => node.remove());
          viewportRef.current = null;
        };

        const resumeStack = async () => {
          const snap = mprHeld;
          if (!snap || !elementRef.current) return;
          mprHeld = null;
          engine.enableElement({
            viewportId,
            type: core.Enums.ViewportType.STACK,
            element: elementRef.current,
          });
          const vp = engine.getViewport(viewportId) as unknown as DrivableViewport;
          tg.addViewport(viewportId, renderingEngineId);
          viewportRef.current = vp;
          const index = Math.max(0, Math.min(snap.imageIds.length - 1, snap.index));
          const window = pinnedVoi ?? heldVoi;
          if (window) pinVoi(window.ww, window.wc);
          // setStack writes the DICOM window and emits VOI_MODIFIED before
          // this await returns. Hold the pin across that, then write it last.
          pinLocked = true;
          try {
            await vp.setStack(snap.imageIds, index);
            applyPinnedVoi();
          } finally {
            requestAnimationFrame(() => {
              applyPinnedVoi();
              pinLocked = false;
            });
          }
          if (snap.fit) vp.resetCamera();
          else {
            if (Number.isFinite(snap.zoom)) vp.setZoom(snap.zoom);
            if (snap.pan) vp.setPan(snap.pan);
          }
          vp.setProperties({ invert: snap.invert });
          vp.render();
          setInverted(snap.invert);
          publishReadout();
        };

        let mprEpoch = 0;
        const destroyMprSession = () => {
          const session = mprSessionRef.current;
          mprSessionRef.current = null;
          session?.destroy();
        };

        const mountMpr = async () => {
          const token = ++mprEpoch;
          const ids = currentIds();
          if (!ids.length || disposed || viewModeRef.current !== "mpr") return;
          await warmPlaneMetadata(ids);
          if (token !== mprEpoch || disposed || viewModeRef.current !== "mpr") return;
          const verdict = assessIds(ids);
          if (!verdict.ok) {
            setMprNotice(verdict.message);
            setMprLive(false);
            setMprLoading(false);
            return;
          }
          const axial = axialRef.current;
          const coronal = coronalRef.current;
          const sagittal = sagittalRef.current;
          if (!axial || !coronal || !sagittal) return;
          setMprNotice(null);
          setMprLoading(true);
          const index =
            viewportRef.current?.getCurrentImageIdIndex() ??
            mprHeld?.index ??
            stackOpenIndex(ids.length);
          const imageId = ids[Math.max(0, Math.min(ids.length - 1, index))];
          const { mountMprSession } = await import("../lib/mprSession");
          if (token !== mprEpoch || disposed || viewModeRef.current !== "mpr") {
            if (!disposed) setMprLoading(false);
            return;
          }
          let session: MprSessionHandle | null = null;
          try {
            suspendStack();
            session = await mountMprSession({
              renderingEngineId,
              instanceId,
              elements: { axial, coronal, sagittal, volume3d: volume3dRef.current },
              modality: modalityRef.current ?? null,
              imageIds: mprHeld?.imageIds ?? ids,
              initialImageId: imageId,
              voi: pinnedVoi ?? heldVoi,
              invert: mprHeld?.invert,
              leftTool: leftTool ?? "WindowLevel",
              onAxialImage: (nextId) => {
                if (!mprHeld || suppressed()) return;
                const idx = mprHeld.imageIds.indexOf(nextId);
                if (idx < 0 || idx === mprHeld.index) return;
                mprHeld.index = idx;
                mprHeld.fit = false;
                emit({ type: "slice", index: idx });
                scheduleReadout();
              },
              onVoi: (ww, wc) => {
                if (!mprHeld || suppressed()) return;
                heldVoi = { ww, wc };
                pinnedVoi = { ww, wc };
                scheduleReadout();
                const now = performance.now();
                if (now - lastVoiEmit < THROTTLE) return;
                lastVoiEmit = now;
                emit({ type: "voi", ww, wc });
              },
              readPlane: (id) => {
                try {
                  const plane = core.metaData.get("imagePlaneModule", id);
                  return plane && typeof plane === "object" ? (plane as PlaneSample) : null;
                } catch {
                  return null;
                }
              },
            });
          } catch (err) {
            console.error("CornerstoneViewer MPR", safeErrorText(err));
            session?.destroy();
            if (mprHeld) await resumeStack();
            if (!disposed) {
              setMprNotice(mprLoadFailureMessage());
              setMprLive(false);
              setMprLoading(false);
            }
            return;
          }
          if (token !== mprEpoch || disposed || viewModeRef.current !== "mpr") {
            session.destroy();
            if (mprHeld) await resumeStack();
            if (!disposed) setMprLoading(false);
            return;
          }
          mprSessionRef.current = session;
          setMprLive(true);
          setMprLoading(false);
          // MPR's left button is the linked crosshair unless the reader had
          // window/level, pan or zoom picked (the session made the same call).
          setActiveTool(
            leftTool && ["WindowLevel", "Pan", "Zoom"].includes(leftTool) ? leftTool : "Crosshairs"
          );
          if (mprRenderRef.current !== "mpr") {
            const ok = await session.setRender(mprRenderRef.current);
            if (!ok) setMprRender("mpr");
          }
          publishReadout();
          // The grid was visibility:hidden while the viewports attached.
          // Resize once it is shown so the canvases match the laid-out planes.
          requestAnimationFrame(() => session.resize());
        };

        const syncMpr = async () => {
          if (disposed || viewModeRef.current !== "mpr") return;
          const ids = currentIds();
          await warmPlaneMetadata(ids);
          if (disposed || viewModeRef.current !== "mpr") return;
          const verdict = assessIds(ids);
          const session = mprSessionRef.current;
          const action = nextMprAction({
            mode: "mpr",
            session: Boolean(session),
            canReconstruct: verdict.ok,
            volumeKey: verdict.ok ? mprVolumeKey(ids) : null,
            loadedKey: session?.volumeKey ?? null,
          });
          if (action === "fallback") {
            mprEpoch += 1;
            destroyMprSession();
            setMprLive(false);
            setMprLoading(false);
            setMprNotice(verdict.ok ? mprLoadFailureMessage() : verdict.message);
            if (mprHeld) await resumeStack();
            return;
          }
          if (action === "replace" && session) {
            setMprNotice(null);
            const index = mprHeld?.index ?? stackOpenIndex(ids.length);
            const imageId = ids[Math.max(0, Math.min(ids.length - 1, index))];
            try {
              await session.replace(ids, imageId, pinnedVoi ?? heldVoi);
              publishReadout();
            } catch (err) {
              console.error("CornerstoneViewer MPR series", safeErrorText(err));
              mprEpoch += 1;
              destroyMprSession();
              setMprLive(false);
              setMprNotice(mprLoadFailureMessage());
              if (mprHeld) await resumeStack();
            }
            return;
          }
          if (action === "mount") await mountMpr();
        };

        enterMprRef.current = async () => {
          if (mprSessionRef.current) return;
          await mountMpr();
        };
        exitMprRef.current = async () => {
          mprEpoch += 1;
          destroyMprSession();
          if (!disposed) {
            setMprLive(false);
            setMprRender("mpr");
            if (leftTool) setActiveTool(leftTool);
            setMprLoading(false);
            if (viewModeRef.current === "stack") setMprNotice(null);
          }
          if (mprHeld && elementRef.current?.isConnected) {
            try {
              await resumeStack();
              // The stack canvas is measured while it is still hidden. Resize
              // again after it is shown so the image fills the pane instead of
              // keeping an MPR cell's aspect ratio.
              const fit = () => {
                const host = elementRef.current;
                if (!host) return;
                host.querySelectorAll("canvas").forEach((node) => {
                  const canvas = node as HTMLCanvasElement;
                  canvas.style.aspectRatio = "auto";
                  canvas.style.width = "100%";
                  canvas.style.height = "100%";
                });
                try {
                  engine.resize(true, true);
                } catch {
                  /* engine already destroyed */
                }
                viewportRef.current?.render();
              };
              requestAnimationFrame(() => {
                fit();
                requestAnimationFrame(fit);
              });
            } catch (err) {
              console.error("CornerstoneViewer MPR resume", safeErrorText(err));
            }
          }
        };

        let switchSeq = 0;
        const switchSeries = async (index: number, emitEvent = true): Promise<void> => {
          const list = seriesRef.current;
          if (!list || list.length === 0) return;
          const clamped = Math.max(0, Math.min(list.length - 1, index));
          if (clamped === loadedSeriesIndexRef.current) return;
          const target = list[clamped];
          const token = ++switchSeq;
          loadedSeriesIndexRef.current = clamped;
          // Record the switch in the stream only for a user-driven change.
          if (emitEvent) emit({ type: "series", seriesInstanceUID: target.seriesInstanceUID });
          // Keep the navigator highlight in sync for BOTH user + replay switches.
          onSeriesChangeRef.current?.(target.seriesInstanceUID);
          cancelTweenRef.current();
          // Drop the previous series' in-flight metadata. Neighbor prefetch
          // stays off until this series' full imageId list is registered.
          try {
            loadAbort.current.abort();
          } catch (err) {
            if ((err as Error)?.name !== "AbortError") throw err;
          }
          const controller = new AbortController();
          loadAbort.current = controller;
          stackIdsRef.current = [];
          prefetchCenter = -1;
          window.clearTimeout(prefetchTimer);
          pixelMarked = false;
          setStacking(true);
          setStatus("Opening slice…");
          const src = caseSeriesToSource(target);
          const seriesUID = seriesUidOf(src);
          activeNav = markViewerNavigation(seriesUID);
          activeSeriesUid = seriesUID;
          beginViewerNavigation(instanceId);
          try {
            let ids: string[] | null = null;
            if (src.kind === "wadors") {
              // Mid-stack of the selected series. Other series stay metadata-only
              // until this click; a teacher landing applies only on first open.
              const job = startProgressiveWadorsLoad({
                wadoRsRoot: src.wadoRsRoot,
                studyInstanceUID: src.StudyInstanceUID,
                seriesInstanceUID: src.SeriesInstanceUID,
                open: null,
                instanceCount: target.instanceCount,
                signal: controller.signal,
              });
              ids = await loadPrepared(job, seriesUID, controller.signal);
              if (!ids || token !== switchSeq || disposed) return;
            } else {
              ids = await buildImageIds(src);
              if (token !== switchSeq || disposed || controller.signal.aborted) return;
              const openAt = stackOpenIndex(ids.length);
              await loadStack(ids, openAt);
              if (token !== switchSeq || disposed || controller.signal.aborted) return;
              noteFirstPixel(seriesUID);
              finishStack(seriesUID, ids, openAt);
            }
            if (!ids) return;
            // MPR is on: the new series' image ids drive the volume. A teacher
            // landing is not applied on a rail switch (open: null above).
            if (viewModeRef.current === "mpr") {
              if (mprHeld) {
                mprHeld.imageIds = ids.slice();
                mprHeld.index = stackOpenIndex(ids.length);
                mprHeld.fit = true;
              }
              await syncMpr();
              if (mprSessionRef.current) return;
            }
            applyPinnedVoi();
          } catch (err) {
            if (disposed || controller.signal.aborted || (err as Error)?.name === "AbortError") {
              return;
            }
            console.error("CornerstoneViewer switchSeries error", safeErrorText(err));
            setStatus(`Error: ${(err as Error).message}`);
          }
        };
        switchSeriesRef.current = switchSeries;

        resetRef.current = () => {
          cancelTweenRef.current();
          releasePinnedVoi();
          heldVoi = null;
          if (mprSessionRef.current) {
            mprSessionRef.current.resetView();
            if (mprHeld) {
              mprHeld.zoom = 1;
              mprHeld.pan = [0, 0];
              mprHeld.fit = true;
              mprHeld.invert = false;
            }
            setInverted(false);
            setActivePreset(null);
            publishReadout();
            return;
          }
          const vp = viewportRef.current;
          if (!vp) return;
          const host = elementRef.current;
          // Fit against the pane's current size. A stale half-width buffer
          // (left over from compare) makes resetCamera miss the anatomy.
          if (host && host.clientWidth >= 2 && host.clientHeight >= 2) {
            try {
              engine.resize(true, false);
            } catch {
              /* resetCamera below still runs */
            }
          }
          vp.resetCamera();
          vp.resetProperties?.();
          vp.render();
          setInverted(vp.getProperties().invert ?? false);
          setActivePreset(null);
          rememberPresentation();
        };
        // Double-click: fit the image to the pane without touching the window.
        fitRef.current = () => {
          cancelTweenRef.current();
          if (mprSessionRef.current) {
            mprSessionRef.current.resetView();
            return;
          }
          const vp = viewportRef.current;
          if (!vp) return;
          try {
            vp.resetCamera();
            vp.render();
            emitCamera();
          } catch {
            /* a 0x0 pane has no camera to fit */
          }
        };
        const clearAnnotations = () => {
          beginSuppress();
          try {
            annotation.state.removeAllAnnotations();
            viewportRef.current?.render();
            mprSessionRef.current?.restoreCrosshairs();
          } catch {
            /* tool state already gone */
          }
          window.setTimeout(() => endSuppress(), 50);
        };
        clearRef.current = clearAnnotations;

        // Place a recorded stroke back onto the viewport (teach guide / applyEvent).
        // Returns false when world mapping isn't available — the caller draws
        // the overlay stroke instead.
        const placeNative = (
          e: Extract<RecordedEvent, { type: "annotation" }>
        ): boolean => {
          const vp = viewportRef.current;
          const host = elementRef.current;
          if (!vp || !host || typeof vp.canvasToWorld !== "function") return false;
          const handles = (e.handles?.length ? e.handles : [e.from, e.to]).filter(
            (p) =>
              Array.isArray(p) &&
              p.length >= 2 &&
              Number.isFinite(p[0]) &&
              Number.isFinite(p[1])
          );
          if (!handles.length) return false;
          const canvas = host.querySelector("canvas");
          const w = canvas?.clientWidth || host.clientWidth || 1;
          const h = canvas?.clientHeight || host.clientHeight || 1;
          let worlds: [number, number, number][];
          try {
            worlds = handles.map(([x, y]) => vp.canvasToWorld!([x * w, y * h]));
          } catch {
            return false;
          }
          if (worlds.some((p) => !p || p.some((n) => !Number.isFinite(n)))) return false;
          const toolName = e.tool || (e.shape === "arrow" ? "ArrowAnnotate" : "Length");
          const imageId =
            typeof vp.getCurrentImageId === "function" ? vp.getCurrentImageId() : undefined;
          const camera = vp.getCamera?.();
          const ann = {
            annotationUID: `guide-${e.annotationUID || "stroke"}-${Date.now().toString(36)}`,
            highlighted: false,
            invalidated: true,
            isLocked: true,
            isVisible: true,
            metadata: {
              toolName,
              referencedImageId: imageId,
              FrameOfReferenceUID: vp.getFrameOfReferenceUID?.(),
              viewPlaneNormal: camera?.viewPlaneNormal,
              viewUp: camera?.viewUp,
            },
            data: {
              handles: {
                points: worlds,
                activeHandleIndex: null,
                textBox: {
                  hasMoved: false,
                  worldPosition: worlds[worlds.length - 1],
                  worldBoundingBox: {
                    topLeft: worlds[0],
                    topRight: worlds[0],
                    bottomLeft: worlds[0],
                    bottomRight: worlds[0],
                  },
                },
              },
              label: e.label || "",
              cachedStats: imageId
                ? {
                    [`imageId:${imageId}`]: {
                      length: e.lengthMm,
                      mean: e.meanHu,
                      max: e.maxHu,
                      min: e.minHu,
                      stdDev: e.stdHu,
                      area: e.areaMm2,
                      unit: e.unit,
                      modalityUnit: e.unit,
                    },
                  }
                : {},
            },
          };
          try {
            annotation.state.addAnnotation(
              ann as unknown as Parameters<typeof annotation.state.addAnnotation>[0],
              host
            );
            const trigger = (
              tools as {
                utilities?: {
                  triggerAnnotationRenderForViewportIds?: (ids: string[]) => void;
                };
              }
            ).utilities?.triggerAnnotationRenderForViewportIds;
            trigger?.([viewportId]);
            vp.render();
            return true;
          } catch (err) {
            console.warn("CornerstoneViewer applyEvent annotation", safeErrorText(err));
            return false;
          }
        };
        invertRef.current = (value?: boolean) => {
          const vp = viewportRef.current;
          const cur = vp?.getProperties().invert ?? mprHeld?.invert ?? false;
          const next = value ?? !cur;
          if (vp) {
            vp.setProperties({ invert: next });
            vp.render();
          }
          if (mprHeld) mprHeld.invert = next;
          mprSessionRef.current?.setInvert(next);
          setInverted(next);
          // A user-driven toggle is part of the record stream; a programmatic
          // set (replay) is not (it would echo back into the recording).
          if (value === undefined) emit({ type: "invert", value: next });
        };

        // --- Slice scrollbar / keyboard / cine ------------------------------
        // One entry point for every non-mouse way to change slice. MPR owns
        // its own planes, so these no-op while a volume is on screen.
        setSliceRef.current = (to, silent) => {
          const vp = viewportRef.current;
          if (!vp || mprHeld) return;
          const ids = vp.getImageIds();
          if (ids.length === 0) return;
          const current = vp.getCurrentImageIdIndex();
          const wanted = clampIndex(
            typeof to === "function" ? to(current, ids.length) : to,
            ids.length
          );
          if (wanted === current) return;
          if (silent) beginSuppress();
          chain(async () => {
            try {
              await vp.setImageIdIndex(wanted);
              vp.render();
              applyPinnedVoi();
            } finally {
              if (silent) endSuppress();
            }
          });
        };
        nudgeZoomRef.current = (factor: number) => {
          const vp = viewportRef.current;
          if (!vp || mprHeld || !Number.isFinite(factor) || factor <= 0) return;
          try {
            vp.setZoom(vp.getZoom() * factor);
            vp.render();
            emitCamera();
          } catch {
            /* a 0x0 pane has no camera to scale */
          }
        };

        // --- Replay / teach guide: re-apply ONE recorded event --------------
        // Slice and series are chained so a fast script doesn't race the decoder.
        // Annotation strokes are placed back on the viewport (native tool).
        const applyEvent = (e: RecordedEvent) => {
          if (!viewportRef.current && !mprHeld) return;
          cancelTweenRef.current();
          beginSuppress();
          chain(async () => {
            const live = viewportRef.current;
            if (!live && !mprHeld) return;
            switch (e.type) {
              case "slice": {
                const ids = mprHeld?.imageIds ?? live?.getImageIds() ?? [];
                const idx = Math.max(0, Math.min(Math.max(ids.length - 1, 0), e.index));
                if (live && !mprHeld && idx !== live.getCurrentImageIdIndex()) {
                  await live.setImageIdIndex(idx);
                }
                if (mprHeld) {
                  mprHeld.index = idx;
                  mprHeld.fit = false;
                  const imageId = ids[idx];
                  if (imageId) mprSessionRef.current?.jumpToImageId(imageId);
                  scheduleReadout();
                }
                live?.render();
                applyPinnedVoi();
                break;
              }
              case "voi":
                pinVoi(e.ww, e.wc);
                writeVoi(e.ww, e.wc);
                break;
              case "camera":
                if (mprHeld) {
                  mprHeld.zoom = e.zoom;
                  mprHeld.pan = e.pan;
                  mprHeld.fit = false;
                }
                if (live && !mprHeld) {
                  live.setZoom(e.zoom);
                  live.setPan(e.pan);
                  live.render();
                }
                break;
              case "invert":
                if (mprHeld) mprHeld.invert = e.value;
                live?.setProperties({ invert: e.value });
                live?.render();
                mprSessionRef.current?.setInvert(e.value);
                setInverted(e.value);
                break;
              case "series": {
                const list = seriesRef.current;
                const idx = list?.findIndex(
                  (s) => s.seriesInstanceUID === e.seriesInstanceUID
                );
                if (list && idx != null && idx >= 0) await switchSeries(idx, false);
                break;
              }
              case "annotation":
                annotationApplied = placeNative(e);
                break;
              default:
                break;
            }
          });
          void pending.then(() => endSuppress());
        };

        const getStartState = (): {
          sliceIndex: number;
          ww?: number;
          wc?: number;
          sopInstanceUID?: string;
          zoom?: number;
          pan?: [number, number];
        } => {
          if (mprHeld) {
            const idx = mprHeld.index;
            const imageId = mprHeld.imageIds[idx];
            const voi = heldVoi ?? pinnedVoi;
            return {
              sliceIndex: idx,
              ww: voi?.ww,
              wc: voi?.wc,
              sopInstanceUID: sopUidFromImageId(imageId),
              ...(mprHeld.fit ? {} : { zoom: mprHeld.zoom, pan: mprHeld.pan }),
            };
          }
          const vp = viewportRef.current;
          if (!vp) return { sliceIndex: 0 };
          const v = voiToWwWc(vp.getProperties().voiRange);
          const ids = vp.getImageIds();
          const idx = vp.getCurrentImageIdIndex();
          const imageId =
            typeof vp.getCurrentImageId === "function"
              ? vp.getCurrentImageId()
              : ids[idx];
          const sop = sopUidFromImageId(imageId);
          const zoom = vp.getZoom();
          const pan = vp.getPan();
          return {
            sliceIndex: idx,
            ww: v?.ww,
            wc: v?.wc,
            sopInstanceUID: sop,
            ...(Number.isFinite(zoom) ? { zoom } : {}),
            ...(pan ? { pan } : {}),
          };
        };

        // --- Smooth (interpolated) driving for the guided tour --------------
        // Adaptive: small ΔWW/WC scrolls like a radiologist; large preset jumps snap.
        const setWindow = (
          ww: number,
          wc: number,
          durationMs?: number
        ): Promise<void> => {
          pinVoi(ww, wc);
          const vp = viewportRef.current;
          const session = mprSessionRef.current;
          if (!vp && !session) return Promise.resolve();
          settleWindow?.();
          settleWindow = null;
          const from =
            (vp ? voiToWwWc(vp.getProperties().voiRange) : null) ??
            heldVoi ??
            pinnedVoi ??
            { ww, wc };
          const ms = durationMs ?? voiTransitionMs(from.ww, from.wc, ww, wc);
          cancelTweenRef.current();
          cancelTweenRef.current = () => {};
          const stillPinned = () =>
            pinnedVoi != null && pinnedVoi.ww === ww && pinnedVoi.wc === wc;
          // In-flight slice loads finish after a capped settle and write the
          // DICOM window. Apply again when that chain drains.
          const commit = () => {
            writeVoi(ww, wc);
            void pending.then(() => {
              if (stillPinned()) applyPinnedVoi();
            });
          };
          if (ms <= 0) {
            commit();
            return Promise.resolve();
          }
          beginSuppress();
          return new Promise((resolve) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              if (settleWindow === done) settleWindow = null;
              if (stillPinned()) commit();
              endSuppress();
              resolve();
            };
            settleWindow = done;
            const cancelRaf = tween(
              ms,
              (eased) => {
                const nextWw = lerp(from.ww, ww, eased);
                const nextWc = lerp(from.wc, wc, eased);
                const range = wwWcToVoi(nextWw, nextWc);
                if (vp) {
                  vp.setProperties({ voiRange: range });
                  vp.render();
                }
                mprSessionRef.current?.setVoi(nextWw, nextWc);
                if (mprHeld) heldVoi = { ww: nextWw, wc: nextWc };
              },
              done
            );
            cancelTweenRef.current = () => {
              cancelRaf();
              done();
            };
          });
        };

        const applyPreset = (p: WindowPreset | null) => {
          if (!p) {
            // Full dynamic: reset to the series' own VOI.
            const vp = viewportRef.current;
            cancelTweenRef.current();
            releasePinnedVoi();
            vp?.resetProperties?.();
            vp?.render();
            setActivePreset(FULL_DYNAMIC_ID);
            publishReadout();
            return;
          }
          // Presets are often far apart — let adaptive logic snap bone↔lung.
          setWindow(p.ww, p.wc);
          setActivePreset(p.id);
        };
        applyPresetRef.current = applyPreset;

        const showStateFn = async (
          state: CornerstoneViewerState,
          durationMs = 700
        ): Promise<void> => {
          const vp = viewportRef.current;
          if (!vp && !mprHeld) return;
          cancelTweenRef.current();
          if (
            state.windowWidth != null &&
            state.windowCenter != null &&
            Number.isFinite(state.windowWidth) &&
            Number.isFinite(state.windowCenter)
          ) {
            pinVoi(state.windowWidth, state.windowCenter);
          }

          // Slice change snaps (a new slice must be decoded) before the tween.
          // In MPR the index is the authored stack image. The focal point comes
          // from that image's plane, and only when the plane is present.
          if (state.sliceIndex != null || state.sliceFraction != null) {
            const ids = mprHeld?.imageIds ?? vp?.getImageIds() ?? [];
            const idx =
              ids.length === 0
                ? 0
                : state.sliceIndex != null
                  ? Math.max(0, Math.min(ids.length - 1, Math.round(state.sliceIndex)))
                  : Math.max(
                      0,
                      Math.min(
                        ids.length - 1,
                        Math.round((state.sliceFraction as number) * (ids.length - 1))
                      )
                    );
            if (vp && idx !== vp.getCurrentImageIdIndex()) {
              try {
                await vp.setImageIdIndex(idx);
              } catch (err) {
                if ((err as Error)?.name === "AbortError") return;
                throw err;
              }
              // The new image brings its DICOM window. The pin (this state's
              // window, or the teach window already on screen) has to win
              // before the camera tween samples VOI.
              applyPinnedVoi();
            }
            if (mprHeld && ids.length) {
              const previous = mprHeld.index;
              mprHeld.index = idx;
              mprHeld.fit = false;
              const imageId = ids[idx];
              if (imageId) mprSessionRef.current?.jumpToImageId(imageId);
              if (previous !== idx && !suppressed()) emit({ type: "slice", index: idx });
              scheduleReadout();
            }
          }

          if (!vp) {
            if (state.zoom != null && mprHeld) {
              mprHeld.zoom = state.zoom;
              mprHeld.fit = false;
            }
            if (state.pan && mprHeld) {
              mprHeld.pan = state.pan;
              mprHeld.fit = false;
            }
            const toWw = state.windowWidth ?? heldVoi?.ww ?? pinnedVoi?.ww;
            const toWc = state.windowCenter ?? heldVoi?.wc ?? pinnedVoi?.wc;
            if (toWw != null && toWc != null) return setWindow(toWw, toWc);
            return;
          }

          const fromVoi = voiToWwWc(vp.getProperties().voiRange);
          const toWw = state.windowWidth ?? fromVoi?.ww;
          const toWc = state.windowCenter ?? fromVoi?.wc;
          const fromZoom = vp.getZoom();
          const toZoom = state.zoom ?? fromZoom;
          const fromPan = vp.getPan();
          const toPan = state.pan ?? fromPan;

          const voiMs =
            fromVoi && toWw != null && toWc != null
              ? voiTransitionMs(fromVoi.ww, fromVoi.wc, toWw, toWc)
              : 0;
          // Camera keeps a calm cinematic duration; VOI may snap independently.
          const cameraMs = Math.max(0, durationMs);
          const totalMs = Math.max(voiMs, cameraMs);

          if (voiMs <= 0 && fromVoi && toWw != null && toWc != null) {
            vp.setProperties({ voiRange: wwWcToVoi(toWw, toWc) });
            vp.render();
          }

          if (totalMs <= 0) {
            if (toZoom != null) vp.setZoom(toZoom);
            if (toPan) vp.setPan(toPan);
            vp.render();
            return;
          }

          return new Promise<void>((resolve) => {
            cancelTweenRef.current = tween(totalMs, (e) => {
              if (voiMs > 0 && fromVoi && toWw != null && toWc != null) {
                const ve = Math.min(1, (e * totalMs) / voiMs);
                vp.setProperties({
                  voiRange: wwWcToVoi(
                    lerp(fromVoi.ww, toWw, ve),
                    lerp(fromVoi.wc, toWc, ve)
                  ),
                });
              }
              if (cameraMs > 0) {
                const ce = Math.min(1, (e * totalMs) / cameraMs);
                vp.setZoom(lerp(fromZoom, toZoom, ce));
                vp.setPan([
                  lerp(fromPan[0], toPan[0], ce),
                  lerp(fromPan[1], toPan[1], ce),
                ]);
              }
              vp.render();
            }, resolve);
          });
        };

        const getMeasurements = (): FindingMeasurement[] => {
          const vp = viewportRef.current;
          const el = elementRef.current;
          if (!vp || !el || typeof vp.worldToCanvas !== "function") return [];
          const start = getStartState();
          const canvas = el.querySelector("canvas");
          const w = canvas?.clientWidth || el.clientWidth || 1;
          const h = canvas?.clientHeight || el.clientHeight || 1;
          const all =
            (annotation.state.getAllAnnotations?.() as RawAnnotationLike[] | undefined) ??
            [];
          // Fallback: gather per-tool if getAllAnnotations is unavailable.
          const list =
            all.length > 0
              ? all
              : (["Length", "EllipticalROI", "RectangleROI", "Probe", "ArrowAnnotate", "Angle"] as const).flatMap(
                  (toolName) => {
                    try {
                      return (annotation.state.getAnnotations(toolName, el) ??
                        []) as RawAnnotationLike[];
                    } catch {
                      return [];
                    }
                  }
                );

          const mapped = list.map((raw) => {
            const points = raw.data?.handles?.points ?? [];
            const handlesPct: Array<[number, number]> = [];
            for (const pt of points) {
              if (!Array.isArray(pt) || pt.length < 2) continue;
              const world = pt as [number, number, number];
              const [cx, cy] = vp.worldToCanvas!(world);
              handlesPct.push([
                Math.min(1, Math.max(0, cx / w)),
                Math.min(1, Math.max(0, cy / h)),
              ]);
            }
            return {
              raw,
              handlesPct,
              sopInstanceUID: start.sopInstanceUID,
              sliceIndex: start.sliceIndex,
            };
          });
          return normalizeMeasurements(mapped);
        };

        let restoring = false;
        let pendingForce = false;
        const applyLayoutRestore = (force: boolean) => {
          const vp = viewportRef.current;
          const host = elementRef.current;
          if (mprSessionRef.current) {
            mprSessionRef.current.resize();
          }
          if (!vp || !host || restoring) return;
          const width = host.clientWidth;
          const height = host.clientHeight;
          if (width < 2 || height < 2) return;
          let live: ViewPresentation;
          try {
            const voi = voiToWwWc(vp.getProperties().voiRange);
            live = {
              sliceIndex: vp.getCurrentImageIdIndex(),
              zoom: vp.getZoom(),
              pan: vp.getPan(),
              ww: voi?.ww,
              wc: voi?.wc,
            };
          } catch {
            return;
          }
          const sizeUnchanged =
            Math.abs(width - lastRestoreW) < 2 && Math.abs(height - lastRestoreH) < 2;
          if (!force && sizeUnchanged && presentationCameraUsable(live)) return;
          const plan = planViewportLayoutRestore({
            width,
            height,
            live,
            lastGood,
          });
          const gen = ++layoutGen;
          restoring = true;
          try {
            try {
              engine.resize(true, plan.keepCamera);
            } catch (err) {
              console.warn("CornerstoneViewer layout restore", safeErrorText(err));
            }
            const paint = () => {
              if (gen !== layoutGen) return;
              const current = viewportRef.current;
              if (!current) return;
              if (!plan.keepCamera) {
                try {
                  current.resetCamera();
                } catch {
                  /* resize already fitted */
                }
                if (plan.reapply) {
                  try {
                    current.setZoom(plan.reapply.zoom);
                    current.setPan(plan.reapply.pan);
                  } catch {
                    /* the fit camera still shows the slice */
                  }
                }
              }
              // Read the pin now, not the VOI captured when this resize was
              // scheduled. A teach beat may have set lung windows since, and
              // resize/resetCamera must not leave the DICOM default behind.
              // Kept when the camera is kept — compare close included.
              const snapshot =
                plan.ww != null && plan.wc != null ? { ww: plan.ww, wc: plan.wc } : null;
              const wanted = resolveViewportVoi({
                requested: pinnedVoi,
                live: snapshot,
              });
              if (wanted) writeVoi(wanted.ww, wanted.wc);
              current.render();
              lastRestoreW = width;
              lastRestoreH = height;
              rememberPresentation();
              publishView();
            };
            if (!plan.keepCamera && plan.sliceIndex !== vp.getCurrentImageIdIndex()) {
              Promise.resolve(vp.setImageIdIndex(plan.sliceIndex)).finally(paint);
            } else {
              paint();
            }
          } finally {
            restoring = false;
          }
        };
        const scheduleLayoutRestore = (force: boolean) => {
          pendingForce = pendingForce || force;
          if (restoreRaf) return;
          let attempts = 0;
          const tick = () => {
            const host = elementRef.current;
            if (!host) {
              restoreRaf = 0;
              return;
            }
            if ((host.clientWidth < 2 || host.clientHeight < 2) && attempts < 8) {
              attempts += 1;
              restoreRaf = requestAnimationFrame(tick);
              return;
            }
            restoreRaf = 0;
            const forced = pendingForce;
            pendingForce = false;
            applyLayoutRestore(forced);
          };
          restoreRaf = requestAnimationFrame(tick);
        };

        const handle: CornerstoneControls = {
          fit: () => fitRef.current(),
          ready: true,
          imageCount: imageIds.length,
          showState: showStateFn,
          setWindow,
          setInvert: (v: boolean) => invertRef.current(v),
          reset: () => resetRef.current(),
          restoreLayout: () => scheduleLayoutRestore(true),
          applyEvent,
          getStartState,
          getMeasurements,
          // Getters so callers always read the LIVE series list + active series
          // (both change as the rail loads / the viewer switches series).
          get seriesUIDs() {
            return (seriesRef.current ?? []).map((s) => s.seriesInstanceUID);
          },
          get activeSeriesUID() {
            return seriesRef.current?.[loadedSeriesIndexRef.current]?.seriesInstanceUID;
          },
          showSeries: (uid: string) => {
            const list = seriesRef.current;
            const idx = list?.findIndex((s) => s.seriesInstanceUID === uid);
            if (list && idx != null && idx >= 0) {
              beginSuppress();
              chain(() => switchSeries(idx, false));
              void pending.then(() => endSuppress());
            }
          },
          clearAnnotations,
          settle: () => pending,
          get annotationApplied() {
            return annotationApplied;
          },
          captureViewportStill: () =>
            grabViewportStill(
              mprSessionRef.current ? axialRef.current : elementRef.current,
              viewportRef.current
            ),
          captureViewportStream: () =>
            openViewportStream(mprSessionRef.current ? axialRef.current : elementRef.current),
          subscribeView: (listener) => {
            viewListeners.add(listener);
            const frame = readProjector();
            listener(frame);
            return () => viewListeners.delete(listener);
          },
        };
        publishView();
        if (controls) controls.current = handle;
        onReady?.(handle);
        // A view link names a window. Apply it once the stack is drivable;
        // the caller's own setWindow (teach) still wins afterwards.
        const linkedWindow = initialWindowRef.current;
        if (linkedWindow && linkedWindow.ww > 0) {
          void setWindow(linkedWindow.ww, linkedWindow.wc, 0);
        }

        if (elementRef.current && typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => scheduleLayoutRestore(false));
          resizeObserver.observe(elementRef.current);
        }

        setReady(true);
        setStatus(`${imageIds.length} images loaded`);
      } catch (err) {
        if (disposed || (err as Error)?.name === "AbortError") return;
        console.error("CornerstoneViewer error", safeErrorText(err));
        setStacking(false);
        setStatus(`Error: ${(err as Error).message}`);
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("unhandledrejection", onLoaderRejection, true);
      // abort() throws into this cleanup under React strict mode and Next
      // turns that into an error toast on top of the study. The load checks
      // `disposed` and drops the result.
      cancelTweenRef.current();
      mprSessionRef.current?.destroy();
      mprSessionRef.current = null;
      enterMprRef.current = async () => {};
      exitMprRef.current = async () => {};
      window.clearTimeout(readoutTimerRef.current);
      window.clearTimeout(prefetchTimer);
      if (restoreRaf) cancelAnimationFrame(restoreRaf);
      if (viewRaf) cancelAnimationFrame(viewRaf);
      viewListeners.clear();
      resizeObserver?.disconnect();
      detachListeners();
      detachQuality();
      viewportRef.current = null;
      setEditCtx(null);
      loadedSeriesIndexRef.current = -1;
      // Allow the effect to FULLY re-initialize on a source change (the engine
      // is torn down here). Without this reset a new source would destroy the
      // engine and the re-run would early-return, leaving a blank viewport.
      started.current = false;
      if (controls) controls.current = null;
      // Drop this pane's tool group before the viewport so a shared engine
      // is not destroyed out from under the primary pane.
      destroyToolGroupRef.current(toolGroupId);
      const plan = viewportEngineRegistry.release(instanceId);
      const engine = sharedCore?.getRenderingEngine(SHARED_RENDERING_ENGINE_ID);
      if (!engine || engine.hasBeenDestroyed) return;
      try {
        if (plan.destroyEngine) engine.destroy();
        else if (plan.disableViewport && engine.getViewport(viewportId)) {
          engine.disableElement(viewportId);
        }
      } catch {
        /* already gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // MPR mounts only after the toggle. Stack stays the default and is what
  // teach scripts drive; a volume replaces it for the session, then comes back.
  // Do not exit from this effect's cleanup: strict mode re-runs the effect
  // while the first mount is still in flight, and that exit would resume the
  // stack under the volume that the second mount just created.
  useEffect(() => {
    if (!ready) return;
    if (viewMode !== "mpr") {
      void exitMprRef.current();
      return;
    }
    void enterMprRef.current();
  }, [viewMode, ready]);

  // MIP / 3D on the live volume. 3D needs a WebGL2 volume pipeline; when it
  // cannot start, fall back to thin MPR and say why.
  useEffect(() => {
    const session = mprSessionRef.current;
    if (!mprLive || !session) return;
    let cancelled = false;
    void session.setRender(mprRender).then((ok) => {
      if (cancelled || ok) return;
      setMprRender("mpr");
      flash("3D isn't available on this device");
    });
    return () => {
      cancelled = true;
    };
  }, [mprRender, mprLive, flash]);

  useEffect(() => {
    const session = mprSessionRef.current;
    if (!mprLive || !session || mprRender !== "3d") return;
    const ct = (modality ?? "").toUpperCase() === "CT";
    session.setVolumeLook?.(ct ? "CT-Bone" : "MR-Default", surface3d);
    session.setCutPlane?.(cut3d, (p) => vtkPlane.newInstance({ origin: p.origin, normal: p.normal }));
  }, [surface3d, cut3d, mprRender, mprLive, modality]);

  // --- Cine ----------------------------------------------------------------
  // A cardiac loop, a dynamic contrast series and a fluoro run are unreadable
  // one frame at a time, and "spin the wheel fast" is not an answer
  // (docs/UI_AUDIT.md backlog #10). Timing lives in lib/cinePlayer.ts; the
  // viewport is advanced silently so a recording is not swamped.
  const sliceCount = readout?.count ?? 0;
  const cineOffered = cineAvailable(sliceCount) && !mprLive && viewMode !== "mpr";
  useEffect(() => {
    if (!cinePlaying) return;
    if (!cineOffered) {
      setCinePlaying(false);
      return;
    }
    const timer = window.setInterval(() => {
      setSliceRef.current(
        (current, count) => advanceCine(cineStateRef.current, current, count, cineWrap).index,
        true
      );
    }, cineFrameMs(cineFps));
    return () => window.clearInterval(timer);
  }, [cinePlaying, cineOffered, cineFps, cineWrap]);

  // Touching the stack stops the loop, the way a reading room expects.
  useEffect(() => {
    if (!cinePlaying) return;
    const host = elementRef.current;
    if (!host) return;
    const stop = () => setCinePlaying(false);
    host.addEventListener("pointerdown", stop);
    host.addEventListener("wheel", stop, { passive: true });
    return () => {
      host.removeEventListener("pointerdown", stop);
      host.removeEventListener("wheel", stop);
    };
  }, [cinePlaying]);

  // A series switch or an MPR entry invalidates the loop's frame count.
  useEffect(() => {
    setCinePlaying(false);
  }, [activeSeriesIndex, sourceKey, viewMode]);

  // --- Preview lock ---------------------------------------------------------
  // While the slice is an 8-bit preview (lib/dicomCdn/previewLock.ts), a
  // left-button / one-finger press with Window/Level or a measurement tool is
  // swallowed in the CAPTURE phase on the frame, before Cornerstone's own
  // mousedown/touchstart listeners on the canvas element see it. Wheel,
  // right-drag zoom, middle-drag pan and pinch are untouched.
  useEffect(() => {
    const host = pressGuardRef.current;
    if (!host) return;
    const guard = (event: MouseEvent | TouchEvent) => {
      const press =
        event.type === "touchstart"
          ? { type: event.type, touchCount: (event as TouchEvent).touches.length }
          : { type: event.type, button: (event as MouseEvent).button };
      if (!previewBlocksPress(previewingRef.current, activeToolRef.current, press)) return;
      event.stopPropagation();
      event.preventDefault();
    };
    host.addEventListener("mousedown", guard, true);
    host.addEventListener("touchstart", guard, { capture: true, passive: false });
    return () => {
      host.removeEventListener("mousedown", guard, true);
      host.removeEventListener("touchstart", guard, { capture: true });
    };
  }, []);

  // --- Keyboard ------------------------------------------------------------
  // Bound to the VIEWPORT, not the window: the student session already owns a
  // set of global keys (Space, C/N/P/R/T/F, `[`) and a second global listener
  // would fight it. The host div is focusable, so tabbing or clicking into the
  // image gives the reader a reading-room keyboard — and makes the viewer
  // keyboard-operable at all, which it was not. See lib/viewerHotkeys.ts.
  const onViewerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isTextTarget(event.target)) return;
    if (event.key === "Escape" && helpOpen) {
      event.preventDefault();
      event.stopPropagation();
      setHelpOpen(false);
      return;
    }
    const action = resolveViewerHotkey(event, sliceCount, { questionMarkHelp });
    if (!action) return;
    event.preventDefault();
    if (action.type === "help") event.stopPropagation();
    runViewerAction(action);
  };

  /** One viewer action, from a key or a voice command. */
  const runViewerAction = (action: ViewerHotkeyAction) => {
    switch (action.type) {
      case "tool":
        if (!ready) return;
        if (
          ANNOTATION_TOOL_NAMES.has(action.tool) &&
          (!annotationsEnabled || mprShowing)
        ) {
          flash(mprShowing ? "Measurements stay on the stack" : "No pixel spacing — can't measure");
          return;
        }
        setLeftToolRef.current(action.tool);
        flash(toolLabel(action.tool));
        return;
      case "slice":
        setCinePlaying(false);
        if (mprShowing) {
          // MPR: the plane the reader last touched (axial until then).
          mprSessionRef.current?.scrollPlane(activePlaneRef.current, action.delta);
          return;
        }
        setSliceRef.current((current) => current + action.delta);
        return;
      case "sliceAbsolute":
        if (mprShowing) return;
        setCinePlaying(false);
        setSliceRef.current((_current, count) =>
          action.where === "first" ? 0 : Math.max(0, count - 1)
        );
        flash(action.where === "first" ? "First image" : "Last image");
        return;
      case "zoom":
        nudgeZoomRef.current(action.factor);
        return;
      case "invert":
        invertRef.current();
        flash(inverted ? "Invert off" : "Invert on");
        return;
      case "reset":
        resetRef.current();
        flash("View reset");
        return;
      case "cine":
        if (!cineOffered) {
          flash("Cine needs a longer series");
          return;
        }
        flash(cinePlaying ? "Cine paused" : `Cine ${cineFps} fps`);
        setCinePlaying((playing) => !playing);
        return;
      case "cineFps": {
        if (!cineOffered) return;
        const options = CINE_FPS_OPTIONS as readonly number[];
        const at = Math.max(0, options.indexOf(cineFps));
        const next = options[Math.min(options.length - 1, Math.max(0, at + action.delta))]!;
        setCineFps(clampCineFps(next));
        flash(`Cine ${next} fps`);
        return;
      }
      case "preset": {
        // An 8-bit preview has no real window to set (lib/dicomCdn).
        if (previewingRef.current) {
          flash("Presets unlock when full quality loads");
          return;
        }
        if (action.ordinal === 0) {
          applyPresetRef.current(null);
          flash("Series default window");
          return;
        }
        const preset = presets[action.ordinal - 1];
        if (!preset) return;
        applyPresetRef.current(preset);
        flash(`${preset.label}   ${windowLine(preset.ww, preset.wc) ?? ""}`.trim());
        return;
      }
      case "overlay": {
        const next = nextOverlayDensity(overlay);
        cycleOverlay();
        flash(next === "full" ? "Overlay: full" : next === "basic" ? "Overlay: basic" : "Overlay off");
        return;
      }
      case "mpr":
        if (!ready) return;
        setViewMode((mode) => (mode === "mpr" ? "stack" : "mpr"));
        flash(viewMode === "mpr" ? "Stack" : "MPR");
        return;
      case "layout":
        if (onCycleLayout) onCycleLayout();
        return;
      case "help":
        setHelpOpen((open) => !open);
        return;
    }
  };

  // ── Offline voice commands (components/viewer/voice) ──
  const [voice, setVoice] = useState<{ state: VoiceState; heard?: string | null }>({ state: "off" });
  const voiceSessionRef = useRef<{ stop(): void } | null>(null);
  // Client-only (the server render has no microphone API): no hydration mismatch.
  const [canVoice, setCanVoice] = useState(false);
  useEffect(() => setCanVoice(typeof navigator.mediaDevices?.getUserMedia === "function"), []);
  const voiceActionRef = useRef<(a: VoiceAction) => void>(() => undefined);
  voiceActionRef.current = (a: VoiceAction) => {
    switch (a.type) {
      case "series": {
        if (!series?.length || !onSeriesChangeRef.current) return;
        const next = series[(activeSeriesIndex + a.delta + series.length) % series.length];
        if (next) onSeriesChangeRef.current(next.seriesInstanceUID);
        return;
      }
      case "slice":
        return runViewerAction({ type: "slice", delta: a.delta });
      case "page":
        return runViewerAction({ type: "slice", delta: a.dir * Math.max(1, Math.round(sliceCount / 10)) });
      case "zoom":
        return runViewerAction({ type: "zoom", factor: a.factor });
      case "tool":
        return runViewerAction({ type: "tool", tool: a.tool });
      case "reset":
        return runViewerAction({ type: "reset" });
      case "invert":
        return runViewerAction({ type: "invert" });
      case "mpr":
      case "volume3d":
        return runViewerAction({ type: "mpr" });
      case "layout":
        return runViewerAction({ type: "layout" });
      case "preset": {
        const want = a.name === "abdomen" ? /abdom|soft/i : new RegExp(a.name, "i");
        const at = presets.findIndex((p) => want.test(p.label) || want.test(p.id));
        if (at < 0) return flash(`No ${a.name} window for this series`);
        return runViewerAction({ type: "preset", ordinal: at + 1 });
      }
      case "slab":
      case "slabThickness":
        return flash("Slabs are in the desktop viewer");
      case "stop":
        voiceSessionRef.current?.stop();
        return;
    }
  };
  const toggleVoice = async () => {
    if (voiceSessionRef.current || voice.state === "loading") {
      voiceSessionRef.current?.stop();
      voiceSessionRef.current = null;
      return;
    }
    const { startVoice } = await import("./viewer/voice/voiceSession");
    voiceSessionRef.current = await startVoice({
      modelUrl: "/voice/model.tar.gz",
      onAction: (action, heard) => {
        flash(`“${heard}”`);
        voiceActionRef.current(action);
      },
      onUnrecognized: (heard) => flash(`“${heard}” ?`),
      onState: (state, detail) => {
        setVoice({ state });
        if (state === "error" && detail) flash(detail);
        if (state === "off" || state === "error") voiceSessionRef.current = null;
      },
    });
  };
  useEffect(() => () => voiceSessionRef.current?.stop(), []);

  // Markers live in stack-image fractions. Report MPR only while the volume
  // is on screen (or still mounting). A failed reconstruction keeps the stack.
  const mprShowing = mprLive || (viewMode === "mpr" && mprLoading);
  // Keep the keyboard on the viewer across Stack ↔ MPR. Hiding the focused
  // stack element drops focus to <body>, so the next X (or arrow) went
  // nowhere until the reader clicked the image again.
  const focusSyncArmed = useRef(false);
  useEffect(() => {
    // Not on mount: only a Stack ↔ MPR switch moves focus.
    if (!focusSyncArmed.current) {
      focusSyncArmed.current = true;
      return;
    }
    const active = document.activeElement;
    const wrapper = pressGuardRef.current;
    const lost = !active || active === document.body;
    if (!wrapper || !(lost || wrapper.contains(active))) return;
    const host = mprShowing ? wrapper : elementRef.current;
    if (host && active !== host) host.focus({ preventScroll: true });
  }, [mprShowing]);
  useEffect(() => {
    onViewModeChange?.(mprShowing ? "mpr" : "stack");
  }, [mprShowing, onViewModeChange]);

  // React to the navigator selecting a different series (user-driven switch).
  // Runs after init has wired switchSeriesRef; no-ops on the already-loaded
  // series. Emits a `series` record event so a recording captures the switch.
  useEffect(() => {
    if (!series || series.length === 0 || !ready) return;
    void switchSeriesRef.current(activeSeriesIndex, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeriesIndex, ready, series]);

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    elementRef.current?.focus({ preventScroll: true });
  }, []);

  const toolbar = (
    <ViewerToolbar
      variant={edge || toolbarHost !== undefined ? "edge" : "dock"}
      ready={ready}
      activeTool={activeTool}
      annotationsEnabled={annotationsEnabled}
      measurementsEnabled={!mprLive}
      inverted={inverted}
      activePreset={activePreset}
      presets={presets}
      viewMode={viewMode}
      mprRender={mprRender}
      onMprRender={(mode) => {
        setMprRender(mode);
        if (viewMode !== "mpr") setViewMode("mpr");
      }}
      cineOffered={cineOffered}
      cinePlaying={cinePlaying}
      cineFps={cineFps}
      overlay={overlay}
      onSelectTool={(name) => setLeftToolRef.current(name)}
      onPreset={(preset) => {
        applyPresetRef.current(preset);
        flash(
          preset
            ? `${preset.label}   ${windowLine(preset.ww, preset.wc) ?? ""}`.trim()
            : "Series default window"
        );
      }}
      onInvert={() => invertRef.current()}
      onReset={() => resetRef.current()}
      onClear={() => clearRef.current()}
      onViewMode={setViewMode}
      previewLocked={previewing && !mprLive}
      onCineToggle={() => setCinePlaying((playing) => !playing)}
      onCineFps={(fps) => setCineFps(clampCineFps(fps))}
      onOverlay={cycleOverlay}
      onHelp={() => setHelpOpen((open) => !open)}
      voice={canVoice ? { state: voice.state, onToggle: () => void toggleVoice() } : undefined}
    />
  );

  // --- Slice scrollbar -----------------------------------------------------
  // docs/UI_AUDIT.md backlog #2. Wheel-only scroll is invisible: a reader
  // cannot tell a 240-slice CT from a radiograph, cannot see where they are,
  // and cannot reach the end without 240 notches. The thumb's height is the
  // share of the series one slice represents (floored so it stays grabbable),
  // so series length is legible at a glance. Geometry is in
  // lib/sliceScrollbar.ts. Hidden in MPR, which has its own three planes.
  const sliceDragRef = useRef(false);
  const scrollbarVisible = sliceCount > 1 && ready && !mprShowing;
  const currentSlice = Math.max(0, (readout?.slice ?? 1) - 1);
  const trackPx = scrollTrackRef.current?.clientHeight ?? 0;
  const thumb = thumbGeometry(currentSlice, sliceCount, trackPx || 320);

  const sliceFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = scrollTrackRef.current;
    if (!track) return;
    const box = track.getBoundingClientRect();
    setSliceRef.current(
      indexFromPointer(event.clientY, { top: box.top, height: box.height }, sliceCount)
    );
  };

  const sliceScrollbar = scrollbarVisible ? (
    <div
      ref={scrollTrackRef}
      role="slider"
      tabIndex={-1}
      aria-label="Slice"
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={sliceCount}
      aria-valuenow={readout?.slice ?? 1}
      aria-valuetext={`Slice ${readout?.slice ?? 1} of ${sliceCount}`}
      className={cn(
        "group absolute bottom-10 right-1 top-10 z-10 w-5 cursor-pointer touch-none",
        "flex justify-center rounded-full"
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        sliceDragRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setCinePlaying(false);
        sliceFromEvent(event);
      }}
      onPointerMove={(event) => {
        if (!sliceDragRef.current) return;
        sliceFromEvent(event);
      }}
      onPointerUp={(event) => {
        sliceDragRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        sliceDragRef.current = false;
      }}
    >
      {/* Track: a hairline at rest so it never competes with anatomy, and a
          full-width rail once the pointer is near it or a drag is live. */}
      <div
        className={cn(
          "pointer-events-none h-full w-1 rounded-full bg-white/15 transition-all",
          "group-hover:w-2 group-hover:bg-white/25",
          sliceDragRef.current && "w-2 bg-white/25"
        )}
      >
        <div
          className="w-full rounded-full bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          style={{ marginTop: `${thumb.topPct}%`, height: `${thumb.heightPct}%` }}
        />
      </div>
    </div>
  ) : null;

  const readoutLabel =
    readout == null
      ? undefined
      : readout.ww != null && readout.wc != null
        ? `${readout.plane ? `${readout.plane} ` : ""}Slice ${readout.slice} of ${readout.count}, window ${readout.ww}, level ${readout.wc}`
        : `${readout.plane ? `${readout.plane} ` : ""}Slice ${readout.slice} of ${readout.count}`;

  const corners: ReturnType<typeof overlayCorners> = overlayCorners(
    readout?.meta,
    readout
      ? {
          slice: readout.slice,
          count: readout.count,
          ww: readout.ww,
          wc: readout.wc,
          zoom: readout.zoom,
          plane: readout.plane,
          inverted,
          presetLabel:
            activePreset && activePreset !== FULL_DYNAMIC_ID
              ? WINDOW_PRESETS.find((p) => p.id === activePreset)?.label ?? null
              : null,
          cineFps: cinePlaying ? cineFps : null,
        }
      : null,
    overlay
  );
  if (paneLabel) corners.topLeft.unshift(paneLabel.toUpperCase());
  // Orientation letters only on the stack: the MPR planes carry their own.
  const markers =
    overlay !== "off" && !mprShowing ? orientationMarkers(readout?.meta?.imageOrientationPatient) : null;

  // Grid panes portal one shared bar; a lone pane keeps its own.
  const sharedBar = toolbarHost !== undefined;
  const ownBar = (docked || edge) && !sharedBar;
  const portaledBar =
    sharedBar && active && toolbarHost ? createPortal(toolbar, toolbarHost) : null;

  return (
    <div
      className={cn(
        docked && !sharedBar && "flex w-full flex-col gap-2",
        (edge || sharedBar) && "flex h-full w-full flex-col",
        !docked && !edge && !sharedBar && "relative h-full w-full",
        "min-w-0 max-w-full",
        className
      )}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <div
        ref={pressGuardRef}
        // Keys land here whether the stack or the MPR grid is showing. A
        // click must focus the viewer: Cornerstone's own mousedown handler
        // calls preventDefault, which stops the browser focusing the image,
        // so arrow keys and PageUp/PageDown silently did nothing.
        tabIndex={-1}
        onKeyDown={onViewerKeyDown}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("[role=dialog], button, input, select, a")) return;
          const host = mprShowing ? pressGuardRef.current : elementRef.current;
          if (host && document.activeElement !== host) host.focus({ preventScroll: true });
        }}
        className={cn(
          "outline-none",
          "relative",
          docked && !sharedBar && "w-full",
          (edge || sharedBar) && "min-h-0 flex-1",
          !docked && !edge && !sharedBar && "h-full w-full"
        )}
      >
        <div
          ref={elementRef}
          className={cn(
            "touch-none select-none overscroll-contain bg-imaging",
            "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
            docked && !sharedBar
              ? "aspect-square w-full max-w-full overflow-hidden rounded-lg border border-[#1F1F1F]"
              : "absolute inset-0",
            mprLive && "invisible pointer-events-none"
          )}
          onContextMenu={(e) => e.preventDefault()}
          onDoubleClick={() => {
            // Annotation tools use double-click to edit; leave it to them.
            if (ANNOTATION_TOOL_NAMES.has(activeTool)) return;
            fitRef.current();
          }}
          // Focusable so the reading-room keys (lib/viewerHotkeys.ts) can be
          // scoped to the image instead of fighting the session's global keys,
          // and so the viewer is operable without a mouse at all.
          tabIndex={mprLive ? -1 : 0}
          aria-label={
            sliceCount > 0
              ? `DICOM viewer, image ${readout?.slice ?? 1} of ${sliceCount}. ` +
                "Arrow keys scroll, H lists shortcuts."
              : "DICOM viewer"
          }
          aria-hidden={mprLive || undefined}
          role="img"
          data-viewer-tool={activeTool}
        />
        {!mprLive && (
          <AnnotationEditLayer
            ctx={editCtx}
            seriesImageIds={viewportRef.current?.getImageIds() ?? []}
            eraser={activeTool === "Eraser"}
            handleUndoKeys
          />
        )}
        {sliceScrollbar}
        {(viewMode === "mpr" || mprLive) && (
          <MprLayout
            axialRef={axialRef}
            coronalRef={coronalRef}
            sagittalRef={sagittalRef}
            tool={activeTool}
            live={mprLive}
            loading={mprLoading}
            notice={mprNotice}
            framed={docked && !sharedBar && mprLive}
            render={mprRender}
            volume3dRef={volume3dRef}
            volume3dControls={
              <>
                <label className="flex items-center gap-1">
                  <span className="sr-only">3D rendering</span>
                  <select
                    value={surface3d == null ? "volume" : String(surface3d)}
                    onChange={(e) => setSurface3d(e.target.value === "volume" ? null : Number(e.target.value))}
                    className="rounded bg-black/60 px-1 py-0.5 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <option value="volume">Volume</option>
                    {SURFACE_PRESETS.map((sp) => (
                      <option key={sp.id} value={sp.threshold}>
                        Surface · {sp.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  <span className="sr-only">Cut plane</span>
                  <select
                    value={cut3d?.axis ?? "off"}
                    onChange={(e) =>
                      setCut3d(e.target.value === "off" ? null : { axis: e.target.value as CutAxis, fraction: cut3d?.fraction ?? 0.5 })
                    }
                    className="rounded bg-black/60 px-1 py-0.5 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <option value="off">No cut</option>
                    <option value="axial">Axial cut</option>
                    <option value="coronal">Coronal cut</option>
                    <option value="sagittal">Sagittal cut</option>
                  </select>
                </label>
                {cut3d && (
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={cut3d.fraction}
                    onChange={(e) => setCut3d({ ...cut3d, fraction: Number(e.target.value) })}
                    aria-label="Cut plane position"
                    className="w-20 accent-accent"
                  />
                )}
              </>
            }
            onPlanePointer={(plane) => {
              activePlaneRef.current = plane;
            }}
            axialReadout={
              readout && mprLive
                ? `Im ${readout.slice} / ${readout.count}${
                    windowLine(readout.ww, readout.wc) ? `   ${windowLine(readout.ww, readout.wc)}` : ""
                  }`
                : null
            }
            showLabels={overlay !== "off"}
          />
        )}
        {readout && ready && !mprShowing && (
          <ViewportOverlay
            corners={corners}
            markers={markers}
            scrollbar={scrollbarVisible}
            label={readoutLabel}
          />
        )}

        {!ready && /\b401\b/.test(status) ? (
          // Signed out on a page whose pixels need a session: say so, and
          // offer the way in, instead of a raw "Series metadata 401".
          <div className="absolute inset-0 z-20 flex items-center justify-center p-4">
            <div className="max-w-xs rounded-lg bg-[#181818] px-4 py-3 text-center text-sm text-white ring-1 ring-white/10">
              <p className="font-medium">Sign in to view the images</p>
              <p className="mt-1 text-xs text-white/65">
                Studies stream only to a signed-in reader or a share link.
              </p>
              <a
                href={`/sign-in?next=${encodeURIComponent(
                  typeof window === "undefined" ? "/" : window.location.pathname + window.location.search
                )}`}
                className="mt-3 inline-flex h-9 items-center rounded-md bg-accent px-3 text-xs font-semibold text-accent-foreground transition-[transform,filter] duration-75 hover:brightness-110 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                Sign in
              </a>
            </div>
          </div>
        ) : !ready && !painted && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex items-center gap-2 rounded-md bg-black/80 px-3 py-1.5 text-xs text-white ring-1 ring-white/10">
              {status.startsWith("Error") ? null : (
                <Spinner size="sm" label="Loading" className="text-white" />
              )}
              {status}
            </span>
          </div>
        )}
        {((!ready && painted) || (ready && stacking)) && (
          <p className="pointer-events-none absolute bottom-8 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/80 px-2.5 py-1 text-xs text-white ring-1 ring-white/10">
            {status}
          </p>
        )}
        {previewing && painted && !mprShowing && (
          <p
            className="pointer-events-none absolute bottom-12 right-8 z-10 flex items-center gap-1.5 rounded-md bg-black/80 px-2 py-1 text-xs font-medium text-white ring-1 ring-white/15"
            title="Showing a fast 8-bit preview. Window/level and measurements unlock when the full-quality image arrives."
          >
            <Spinner size="sm" className="text-white/70" label="Loading full-quality image" />
            <span aria-hidden="true">Preview</span>
          </p>
        )}
        <ViewerHud text={hud} />
        <ViewerHelp open={helpOpen} onClose={closeHelp} />
        {mprShowing ? null : imageOverlay}
      </div>
      {ownBar && toolbar}
      {portaledBar}
      {docked && !sharedBar && ready && !annotationsEnabled && (
        <p className="text-xs text-warning">
          This study has no pixel spacing — measurement tools are off.
        </p>
      )}
    </div>
  );
}
