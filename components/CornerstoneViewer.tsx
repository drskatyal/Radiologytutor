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
//   • Edge chrome: student session. The image fills the pane and the same
//     grouped bar sits along its bottom edge — still off the pixels — so a
//     compare layout can give every pane matching chrome.
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

import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import createImageIdsAndCacheMetaData from "../lib/createImageIdsAndCacheMetaData";
import { stackOpenIndex } from "../lib/stackIndex";
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
import { cn } from "@/components/ui/cn";
import {
  Blend,
  ChevronDown,
  Circle,
  Crosshair,
  Eraser,
  Move,
  MoveUpRight,
  Ruler,
  Settings2,
  Square,
  Layers as LayersIconL,
  RotateCcw,
  SunMoon,
  Triangle,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";

// Tools selectable on the LEFT mouse button. Pan/Zoom/Scroll also keep their
// wheel/middle/right bindings so the usual PACS mouse scheme still works.
//
// `annotation: true` marks the measurement/markup tools. These place annotations
// in world space; only the real-world MEASUREMENT (mm vs px) needs per-image
// PixelSpacing — the tools still DRAW correctly without it. So we keep them
// ENABLED by default and only disable them when a study POSITIVELY has no pixel
// spacing at all (e.g. the tiny synthetic multiframe MR we bundle as an offline
// sample). Real DICOMweb / uploaded studies keep the tools live — at worst a
// measurement falls back to pixels, which is far better than a dead control.
type ViewerTool = {
  name: string;
  label: string;
  /** Short visible caption. The accessible name stays `label`. */
  short: string;
  annotation?: boolean;
};

// Primary tools stay on the bar. Measurement tools other than Length live in
// an overflow, matching OHIF's MeasurementTools split + MoreTools — ten equal
// icons is how a toolbar becomes wallpaper.
const NAV_TOOLS: ViewerTool[] = [
  { name: "WindowLevel", label: "Window / Level", short: "W/L" },
  { name: "Pan", label: "Pan", short: "Pan" },
  { name: "Zoom", label: "Zoom", short: "Zoom" },
  { name: "StackScroll", label: "Scroll", short: "Scroll" },
];

const MEASURE_TOOLS: ViewerTool[] = [
  { name: "Length", label: "Length", short: "Length", annotation: true },
  { name: "Angle", label: "Angle", short: "Angle", annotation: true },
  { name: "EllipticalROI", label: "Ellipse ROI", short: "Ellipse", annotation: true },
  { name: "RectangleROI", label: "Rectangle ROI", short: "Rect", annotation: true },
  { name: "Probe", label: "Probe", short: "Probe", annotation: true },
  { name: "ArrowAnnotate", label: "Arrow", short: "Arrow", annotation: true },
];

const PRIMARY_TOOLS: ViewerTool[] = [...NAV_TOOLS, ...MEASURE_TOOLS];

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
  if (source.kind === "wadouri") {
    // frame index is 1-based in the wadouri imageId (loader subtracts 1).
    return Array.from(
      { length: source.frames },
      (_, i) => `wadouri:${source.url}?frame=${i + 1}`
    );
  }
  return createImageIdsAndCacheMetaData(source);
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
}: {
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
}) {
  const chrome = resolveChrome(showToolbar, chromeProp);
  const docked = chrome === "dock";
  const edge = chrome === "edge";
  const elementRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  // Stable handles the toolbar uses after init.
  const setLeftToolRef = useRef<(name: string) => void>(() => {});
  const resetRef = useRef<() => void>(() => {});
  const clearRef = useRef<() => void>(() => {});
  const invertRef = useRef<(value?: boolean) => void>(() => {});
  const applyPresetRef = useRef<(p: WindowPreset | null) => void>(() => {});
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

  const [status, setStatus] = useState("Initializing viewer…");
  const [activeTool, setActiveTool] = useState("WindowLevel");
  const [ready, setReady] = useState(false);
  const [inverted, setInverted] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [measureOpen, setMeasureOpen] = useState(false);
  const [readout, setReadout] = useState<{
    slice: number;
    count: number;
    ww?: number;
    wc?: number;
  } | null>(null);
  const readoutTimerRef = useRef(0);
  // Whether the annotation tools are enabled. Default ENABLED — we only flip to
  // disabled once we POSITIVELY confirm a study has no pixel spacing (e.g. the
  // bundled sample). This avoids the false-negative that killed the tools on
  // real wadors/uploaded studies before their plane metadata had resolved.
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true);
  const destroyToolGroupRef = useRef<(id: string) => void>(() => {});

  const presets = presetsForModality(modality);

  // `source` is often a fresh object with the same study/series (Teach rebuilds
  // the compare descriptor every render). Object identity must not tear the
  // engine down — that reloads the stack at the mid-slice default and strands
  // a secondary landing. Series changes on an existing rail go through
  // switchSeries, which does not change this key.
  const sourceKey = viewerSourceKey(source);

  useEffect(() => {
    let disposed = false;
    let detachListeners: () => void = () => {};
    let resizeObserver: ResizeObserver | null = null;
    let restoreRaf = 0;
    const viewportId = viewportIdFor(instanceId);
    const toolGroupId = toolGroupIdFor(instanceId);
    // One engine for every pane. A second RenderingEngine allocates another
    // WebGL context pool; opening compare then loses the primary context and
    // the canvas clears to black when the split closes.
    const renderingEngineId = SHARED_RENDERING_ENGINE_ID;

    (async () => {
      if (started.current || !elementRef.current) return;
      started.current = true;
      viewportEngineRegistry.acquire(instanceId);

      try {
        const core = await import("@cornerstonejs/core");
        const loader = await import("@cornerstonejs/dicom-image-loader");
        const tools = await import("@cornerstonejs/tools");
        sharedCore = core as unknown as EngineHost;

        await core.init();
        await tools.init();
        const workers = Math.min(4, navigator.hardwareConcurrency || 4);
        await loader.init({ maxWebWorkers: workers });
        // Default interaction pool is 6. Google's DICOM viewer guidance, same
        // region, moves ~0.5 MB frames from ~30 FPS at 6-wide to ~60 FPS near 20.
        // 16 leaves headroom for metadata. Compute stays at the library default.
        const retrieval = (
          core as {
            imageRetrievalPoolManager?: { maxNumRequests?: Record<string, number> };
          }
        ).imageRetrievalPoolManager;
        const pool = retrieval?.maxNumRequests;
        if (pool) {
          pool.interaction = 16;
          pool.thumbnail = 8;
          pool.prefetch = 8;
        }

        setStatus("Loading series…");
        const imageIds = await buildImageIds(initialSource);
        if (disposed || !elementRef.current) return;

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
        ].forEach((T) => tg.addTool(T.toolName));
        tg.addViewport(viewportId, renderingEngineId);

        const { MouseBindings } = toolsEnums;
        // Fixed bindings: wheel = scroll, right = zoom, middle = pan. These are
        // permanent and never move to/from the left button.
        tg.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Wheel }],
        });
        tg.setToolActive(ZoomTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Secondary }],
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
        // remove ONLY the Primary binding from the outgoing tool before giving
        // it to the incoming one — so exactly one tool ever owns the left button.
        // (The same algorithm is modelled + unit-tested in lib/toolBindings.ts.)
        let leftTool: string | null = null;
        const setLeftTool = (name: string) => {
          const primary = { mouseButton: MouseBindings.Primary };
          if (leftTool && leftTool !== name) {
            // Drop only the Primary binding from the outgoing tool. Pan/Zoom/
            // Scroll keep their permanent wheel/right/middle bindings (and stay
            // active); WindowLevel/annotation tools become passive.
            tg.setToolPassive(leftTool, { removeAllBindings: [primary] });
          }
          tg.setToolActive(name, { bindings: [primary] });
          leftTool = name;
          setActiveTool(name);
        };
        setLeftTool("WindowLevel");
        setLeftToolRef.current = setLeftTool;

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
        const publishReadout = () => {
          const vp = viewportRef.current;
          if (!vp) return;
          const v = voiToWwWc(vp.getProperties().voiRange);
          const count = vp.getImageIds().length;
          const slice = displaySliceNumber(vp.getCurrentImageIdIndex());
          const ww = v ? Math.round(v.ww) : undefined;
          const wc = v ? Math.round(v.wc) : undefined;
          setReadout((prev) =>
            prev &&
            prev.slice === slice &&
            prev.count === count &&
            prev.ww === ww &&
            prev.wc === wc
              ? prev
              : { slice, count, ww, wc }
          );
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

        const loadStack = async (ids: string[]): Promise<void> => {
          await viewport.setStack(ids, stackOpenIndex(ids.length));
          viewport.render();

          const sampleIds = ids.slice(0, Math.min(ids.length, 4));
          const evaluateAnnotatable = () => {
            const annotatable = sampleIds.some((id) =>
              imageSupportsAnnotation(core.metaData, id)
            );
            setAnnotationsEnabled(annotatable);
            if (!annotatable && leftTool && ANNOTATION_TOOL_NAMES.has(leftTool)) {
              setLeftTool("WindowLevel");
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

        await loadStack(imageIds);
        if (disposed || !elementRef.current) return;
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
          const vp = viewportRef.current;
          const wanted = finiteVoi(ww, wc);
          if (!vp || !wanted) return false;
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
          publishReadout();
          const live = voiToWwWc(vp.getProperties().voiRange);
          return (
            live != null &&
            Math.abs(live.ww - wanted.ww) <= 1 &&
            Math.abs(live.wc - wanted.wc) <= 1
          );
        };

        const pinVoi = (ww: number, wc: number) => {
          const next = finiteVoi(ww, wc);
          if (next) pinnedVoi = next;
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

        const emitSlice = () => {
          const vp = viewportRef.current;
          if (!vp) return;
          rememberPresentation();
          emit({ type: "slice", index: vp.getCurrentImageIdIndex() });
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
          if (v && !suppressed()) pinnedVoi = { ww: v.ww, wc: v.wc };
          const now = performance.now();
          if (now - lastVoiEmit < THROTTLE) return;
          lastVoiEmit = now;
          if (v) emit({ type: "voi", ww: v.ww, wc: v.wc });
        };
        const emitCamera = () => {
          const vp = viewportRef.current;
          if (!vp) return;
          rememberPresentation();
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
          try {
            const ids = await buildImageIds(caseSeriesToSource(target));
            // A newer switch superseded us, or we've been torn down — bail.
            if (token !== switchSeq || disposed) return;
            await loadStack(ids);
            applyPinnedVoi();
          } catch (err) {
            console.error("CornerstoneViewer switchSeries error", err);
          }
        };
        switchSeriesRef.current = switchSeries;

        resetRef.current = () => {
          cancelTweenRef.current();
          releasePinnedVoi();
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
          viewport.resetCamera();
          viewport.resetProperties?.();
          viewport.render();
          setInverted(viewport.getProperties().invert ?? false);
          setActivePreset(null);
          rememberPresentation();
        };
        const clearAnnotations = () => {
          beginSuppress();
          try {
            annotation.state.removeAllAnnotations();
            viewportRef.current?.render();
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
            console.warn("CornerstoneViewer applyEvent annotation", err);
            return false;
          }
        };
        invertRef.current = (value?: boolean) => {
          const cur = viewport.getProperties().invert ?? false;
          const next = value ?? !cur;
          viewport.setProperties({ invert: next });
          viewport.render();
          setInverted(next);
          // A user-driven toggle is part of the record stream; a programmatic
          // set (replay) is not (it would echo back into the recording).
          if (value === undefined) emit({ type: "invert", value: next });
        };

        // --- Replay / teach guide: re-apply ONE recorded event --------------
        // Slice and series are chained so a fast script doesn't race the decoder.
        // Annotation strokes are placed back on the viewport (native tool).
        const applyEvent = (e: RecordedEvent) => {
          const vp = viewportRef.current;
          if (!vp) return;
          cancelTweenRef.current();
          beginSuppress();
          chain(async () => {
            const live = viewportRef.current;
            if (!live) return;
            switch (e.type) {
              case "slice": {
                const ids = live.getImageIds();
                const idx = Math.max(0, Math.min(ids.length - 1, e.index));
                if (idx !== live.getCurrentImageIdIndex()) {
                  await live.setImageIdIndex(idx);
                }
                live.render();
                applyPinnedVoi();
                break;
              }
              case "voi":
                pinVoi(e.ww, e.wc);
                writeVoi(e.ww, e.wc);
                break;
              case "camera":
                live.setZoom(e.zoom);
                live.setPan(e.pan);
                live.render();
                break;
              case "invert":
                live.setProperties({ invert: e.value });
                live.render();
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
          if (!vp) return Promise.resolve();
          settleWindow?.();
          settleWindow = null;
          const from = voiToWwWc(vp.getProperties().voiRange) ?? { ww, wc };
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
                vp.setProperties({
                  voiRange: wwWcToVoi(
                    lerp(from.ww, ww, eased),
                    lerp(from.wc, wc, eased)
                  ),
                });
                vp.render();
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
          if (!vp) return;
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
          if (state.sliceIndex != null || state.sliceFraction != null) {
            const ids = vp.getImageIds();
            const idx =
              state.sliceIndex != null
                ? Math.max(0, Math.min(ids.length - 1, Math.round(state.sliceIndex)))
                : Math.max(
                    0,
                    Math.min(
                      ids.length - 1,
                      Math.round((state.sliceFraction as number) * (ids.length - 1))
                    )
                  );
            if (idx !== vp.getCurrentImageIdIndex()) {
              await vp.setImageIdIndex(idx);
              // The new image brings its DICOM window. The pin (this state's
              // window, or the teach window already on screen) has to win
              // before the camera tween samples VOI.
              applyPinnedVoi();
            }
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
              console.warn("CornerstoneViewer layout restore", err);
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
          captureViewportStill: () => grabViewportStill(elementRef.current, viewportRef.current),
          captureViewportStream: () => openViewportStream(elementRef.current),
        };
        if (controls) controls.current = handle;
        onReady?.(handle);

        if (elementRef.current && typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => scheduleLayoutRestore(false));
          resizeObserver.observe(elementRef.current);
        }

        setReady(true);
        setStatus(`${imageIds.length} images loaded`);
      } catch (err) {
        console.error("CornerstoneViewer error", err);
        setStatus(`Error: ${(err as Error).message}`);
      }
    })();

    return () => {
      disposed = true;
      cancelTweenRef.current();
      window.clearTimeout(readoutTimerRef.current);
      if (restoreRaf) cancelAnimationFrame(restoreRaf);
      resizeObserver?.disconnect();
      detachListeners();
      viewportRef.current = null;
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

  // React to the navigator selecting a different series (user-driven switch).
  // Runs after init has wired switchSeriesRef; no-ops on the already-loaded
  // series. Emits a `series` record event so a recording captures the switch.
  useEffect(() => {
    if (!series || series.length === 0 || !ready) return;
    void switchSeriesRef.current(activeSeriesIndex, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeriesIndex, ready, series]);

  // Close the preset menu on outside click / Escape.
  const presetMenuRef = useRef<HTMLDivElement>(null);
  const measureMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!presetOpen && !measureOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const node = e.target as Node;
      if (presetMenuRef.current?.contains(node)) return;
      if (measureMenuRef.current?.contains(node)) return;
      setPresetOpen(false);
      setMeasureOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPresetOpen(false);
        setMeasureOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [presetOpen, measureOpen]);

  const activePresetLabel =
    activePreset === FULL_DYNAMIC_ID
      ? "Full dynamic"
      : WINDOW_PRESETS.find((p) => p.id === activePreset)?.label ?? "W/L";

  const activeToolMeta = PRIMARY_TOOLS.find((t) => t.name === activeTool);
  const activeToolLabel = activeToolMeta?.label ?? "Window / Level";

  const toolbar = (
    <ViewerToolbar
      orientation="horizontal"
      compact={edge}
      ready={ready}
      activeTool={activeTool}
      activeToolLabel={activeToolLabel}
      annotationsEnabled={annotationsEnabled}
      inverted={inverted}
      presetOpen={presetOpen}
      measureOpen={measureOpen}
      activePresetLabel={activePresetLabel}
      activePreset={activePreset}
      presets={presets}
      presetMenuRef={presetMenuRef}
      measureMenuRef={measureMenuRef}
      onTogglePreset={() => {
        setMeasureOpen(false);
        setPresetOpen((o) => !o);
      }}
      onToggleMeasure={() => {
        setPresetOpen(false);
        setMeasureOpen((o) => !o);
      }}
      onSelectTool={(name) => {
        setLeftToolRef.current(name);
        setMeasureOpen(false);
      }}
      onPreset={(preset) => {
        applyPresetRef.current(preset);
        setPresetOpen(false);
      }}
      onInvert={() => invertRef.current()}
      onReset={() => resetRef.current()}
      onClear={() => clearRef.current()}
    />
  );

  const readoutLabel =
    readout == null
      ? undefined
      : readout.ww != null && readout.wc != null
        ? `Slice ${readout.slice} of ${readout.count}, window ${readout.ww}, level ${readout.wc}`
        : `Slice ${readout.slice} of ${readout.count}`;

  return (
    <div
      className={cn(
        docked && "flex w-full flex-col gap-2",
        edge && "flex h-full w-full flex-col",
        !docked && !edge && "relative h-full w-full",
        className
      )}
    >
      <div
        className={cn(
          "relative",
          docked && "w-full",
          edge && "min-h-0 flex-1",
          !docked && !edge && "h-full w-full"
        )}
      >
        <div
          ref={elementRef}
          className={cn(
            "bg-imaging",
            docked
              ? "aspect-square w-full overflow-hidden rounded-xl border border-subtle"
              : "absolute inset-0"
          )}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="DICOM viewer"
          role="img"
        />
        {readout && ready && (
          <p
            className="pointer-events-none absolute left-2 top-2 z-10 rounded-md bg-black/80 px-2 py-1 text-xs font-medium leading-tight text-white shadow-md ring-1 ring-white/20"
            aria-label={readoutLabel}
          >
            <span className="block tabular-nums">
              {readout.slice} / {readout.count}
            </span>
            {readout.ww != null && readout.wc != null && (
              <span className="block tabular-nums">
                W {readout.ww} L {readout.wc}
              </span>
            )}
          </p>
        )}
        {!ready && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-md bg-black/80 px-3 py-1.5 text-xs text-white ring-1 ring-white/15">
              {status}
            </span>
          </div>
        )}
      </div>
      {(docked || edge) && toolbar}
      {docked && (
        <p className="text-xs text-secondary">
          <span className="font-medium text-primary">{activeToolLabel}</span>
          {" on the left button · Wheel scroll · right-drag zoom · middle-drag pan"}
          {ready && !annotationsEnabled && (
            <>
              {" · "}
              <span className="text-warning">
                this study has no pixel spacing — measurement tools are disabled
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function ViewerToolbar({
  orientation,
  compact = false,
  ready,
  activeTool,
  activeToolLabel,
  annotationsEnabled,
  inverted,
  presetOpen,
  measureOpen,
  activePresetLabel,
  activePreset,
  presets,
  presetMenuRef,
  measureMenuRef,
  onTogglePreset,
  onToggleMeasure,
  onSelectTool,
  onPreset,
  onInvert,
  onReset,
  onClear,
}: {
  orientation: "horizontal" | "vertical";
  /** Student pane: one tight row, no group captions. */
  compact?: boolean;
  ready: boolean;
  activeTool: string;
  activeToolLabel: string;
  annotationsEnabled: boolean;
  inverted: boolean;
  presetOpen: boolean;
  measureOpen: boolean;
  activePresetLabel: string;
  activePreset: string | null;
  presets: WindowPreset[];
  presetMenuRef: MutableRefObject<HTMLDivElement | null>;
  measureMenuRef: MutableRefObject<HTMLDivElement | null>;
  onTogglePreset: () => void;
  onToggleMeasure: () => void;
  onSelectTool: (name: string) => void;
  onPreset: (preset: WindowPreset | null) => void;
  onInvert: () => void;
  onReset: () => void;
  onClear: () => void;
}) {
  const vertical = orientation === "vertical";
  const activeMeasure =
    MEASURE_TOOLS.find((t) => t.name === activeTool) ?? MEASURE_TOOLS[0];
  const measureActive = MEASURE_TOOLS.some((t) => t.name === activeTool);

  const toolLabel = (tool: ViewerTool) =>
    tool.annotation && !annotationsEnabled
      ? `${tool.label} — this study has no pixel spacing for measurements`
      : tool.label;

  const menuClass = vertical
    ? "absolute left-full top-0 z-30 ml-1.5 w-48 origin-top-left animate-fade-up overflow-hidden rounded-xl border border-strong/70 bg-elevated p-1 shadow-lg"
    : "absolute bottom-full left-0 z-30 mb-1.5 w-48 origin-bottom-left animate-fade-up overflow-hidden rounded-xl border border-strong/70 bg-elevated p-1 shadow-lg";

  const nav = NAV_TOOLS.map((tool) => (
    <ToolButton
      key={tool.name}
      label={tool.label}
      caption={vertical ? undefined : tool.short}
      active={activeTool === tool.name}
      disabled={!ready}
      onClick={() => onSelectTool(tool.name)}
    >
      <ToolIcon name={tool.name} />
    </ToolButton>
  ));

  const measureSplit = (
    <div className={cn("relative flex", vertical ? "flex-col items-center" : "items-end")} ref={measureMenuRef}>
      <ToolButton
        label={toolLabel(activeMeasure)}
        caption={vertical ? undefined : activeMeasure.short}
        active={measureActive}
        disabled={!ready || (!!activeMeasure.annotation && !annotationsEnabled)}
        onClick={() => onSelectTool(activeMeasure.name)}
      >
        <ToolIcon name={activeMeasure.name} />
      </ToolButton>
      <button
        type="button"
        disabled={!ready}
        aria-haspopup="menu"
        aria-expanded={measureOpen}
        aria-label="More measurement tools"
        onClick={onToggleMeasure}
        className={cn(
          "flex items-center justify-center rounded-lg text-secondary transition-colors",
          "hover:bg-overlay hover:text-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          "disabled:cursor-not-allowed disabled:opacity-40",
          vertical ? "h-8 w-9" : "h-12 w-8",
          measureOpen && "bg-overlay text-primary"
        )}
      >
        <ChevronDown
          className={cn("h-3.5 w-3.5", vertical && "-rotate-90")}
          strokeWidth={2.2}
          aria-hidden="true"
        />
      </button>
      {measureOpen && (
        <div role="menu" aria-label="Measurement tools" className={menuClass}>
          {MEASURE_TOOLS.map((tool) => {
            const blocked = !!tool.annotation && !annotationsEnabled;
            return (
              <PresetItem
                key={tool.name}
                label={tool.label}
                hint={blocked ? "no spacing" : tool.short}
                active={activeTool === tool.name}
                disabled={!ready || blocked}
                onClick={() => onSelectTool(tool.name)}
              />
            );
          })}
        </div>
      )}
    </div>
  );

  const presetControl = (
    <div className="relative" ref={presetMenuRef}>
      <button
        type="button"
        disabled={!ready}
        aria-haspopup="menu"
        aria-expanded={presetOpen}
        aria-label={`Window presets, ${activePresetLabel}`}
        onClick={onTogglePreset}
        className={cn(
          "flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          "disabled:cursor-not-allowed disabled:opacity-40",
          vertical ? "h-9 w-9" : "h-12 min-w-12 flex-col px-2 text-xs",
          presetOpen || activePreset
            ? "bg-accent/15 text-accent"
            : "text-secondary hover:bg-overlay hover:text-primary"
        )}
      >
        <ToolIcon name="Preset" />
        {vertical ? null : (
          <span className="max-w-[4.5rem] truncate leading-none">{activePresetLabel}</span>
        )}
      </button>
      {presetOpen && (
        <div role="menu" aria-label="Window/Level presets" className={menuClass}>
          <PresetItem
            label="Full dynamic"
            hint="series default"
            active={activePreset === FULL_DYNAMIC_ID}
            onClick={() => onPreset(null)}
          />
          <span className="my-1 block h-px bg-strong/50" />
          {presets.map((p) => (
            <PresetItem
              key={p.id}
              label={p.label}
              hint={`W ${p.ww}  L ${p.wc}`}
              active={activePreset === p.id}
              onClick={() => onPreset(p)}
            />
          ))}
        </div>
      )}
    </div>
  );

  const display = (
    <>
      {presetControl}
      <ToolButton
        label="Invert"
        caption={vertical ? undefined : "Invert"}
        active={inverted}
        disabled={!ready}
        onClick={onInvert}
      >
        <ToolIcon name="Invert" />
      </ToolButton>
      <ToolButton
        label="Reset view"
        caption={vertical ? undefined : "Reset"}
        disabled={!ready}
        onClick={onReset}
      >
        <ToolIcon name="Reset" />
      </ToolButton>
      <ToolButton
        label="Clear annotations"
        caption={vertical ? undefined : "Clear"}
        disabled={!ready}
        onClick={onClear}
      >
        <ToolIcon name="Clear" />
      </ToolButton>
    </>
  );

  return (
    <div
      role="toolbar"
      aria-label="Viewer tools"
      aria-orientation="horizontal"
      className={cn(
        "flex flex-wrap items-end gap-x-3 gap-y-2 border border-subtle bg-surface px-2 py-2",
        compact ? "rounded-none border-x-0 border-b-0" : "rounded-xl"
      )}
    >
      <div className="flex flex-col gap-1">
        {compact ? null : (
          <span className="px-1 text-xs font-medium text-secondary">Navigate</span>
        )}
        <div className="flex items-center gap-0.5">{nav}</div>
      </div>
      <div className="flex flex-col gap-1">
        {compact ? null : (
          <span className="px-1 text-xs font-medium text-secondary">Measure</span>
        )}
        {measureSplit}
      </div>
      <div className="flex flex-col gap-1">
        {compact ? null : (
          <span className="px-1 text-xs font-medium text-secondary">Display</span>
        )}
        <div className="flex items-center gap-0.5">{display}</div>
      </div>
      {compact ? null : (
        <p className="mb-1 ml-auto hidden text-xs text-secondary sm:block">
          Left button: <span className="font-medium text-primary">{activeToolLabel}</span>
        </p>
      )}
    </div>
  );
}

function ToolButton({
  label,
  caption,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Visible short name under the icon. Omitted on the edge rail. */
  caption?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        "disabled:cursor-not-allowed disabled:opacity-40",
        caption
          ? "flex h-12 min-w-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5"
          : "flex h-9 w-9 items-center justify-center rounded-lg",
        active
          ? "bg-accent text-accent-foreground shadow-sm"
          : "text-secondary hover:bg-overlay hover:text-primary"
      )}
    >
      {children}
      {caption ? (
        <span className="max-w-[3.5rem] truncate text-xs font-medium leading-none">
          {caption}
        </span>
      ) : null}
    </button>
  );
}

function PresetItem({
  label,
  hint,
  active,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active ? "bg-accent/15 text-accent" : "text-secondary hover:bg-surface hover:text-primary"
      )}
    >
      <span className="font-medium">{label}</span>
      <span className="tabular-nums text-secondary">{hint}</span>
    </button>
  );
}

// PACS toolbar glyphs, mapped to lucide icons. Each tool keeps its name; only
// the rendered glyph changed (no Cornerstone tool binding is touched).
const TOOL_ICONS: Record<string, LucideIcon> = {
  WindowLevel: Blend,
  Pan: Move,
  Zoom: ZoomIn,
  StackScroll: LayersIconL,
  Length: Ruler,
  Angle: Triangle,
  EllipticalROI: Circle,
  RectangleROI: Square,
  Probe: Crosshair,
  ArrowAnnotate: MoveUpRight,
  Preset: Settings2,
  Invert: SunMoon,
  Reset: RotateCcw,
  Clear: Eraser,
};

function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS[name];
  if (!Icon) return null;
  return <Icon className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />;
}
