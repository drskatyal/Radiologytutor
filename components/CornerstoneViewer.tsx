"use client";

// Self-hosted Cornerstone3D stack viewer — the "Our Viewer" of FlowRad Learn.
// It owns the full feature set we get from rendering DICOM ourselves: scroll,
// window/level, zoom, pan, native annotations, AND — crucially — programmatic
// driving of the camera/VOI/slice for BOTH:
//   • the guided student walk-through (smoothly INTERPOLATED, via showState), and
//   • exact record → replay (DENSE event re-application, via applyEvent).
//
// Two modes, one component:
//   • Demo (default): the full PACS toolbar + status line. Used by /cornerstone,
//     /record and the author capture surface.
//   • Driven: pass `controls` (a ref) + `showToolbar={false}` and the caller
//     drives the viewport via the imperative handle below.
//
// Mouse: wheel = scroll, right-drag = zoom, middle-drag = pan. The LEFT button
// runs whichever tool is picked in the toolbar (window/level by default).
//
// RECORD/REPLAY: pass `onEvent` to receive an ordered stream of viewer state
// changes (slice / voi / camera / invert) read straight off the viewport — we
// never trust event-detail shapes. Camera/VOI are throttled (~50ms) but order
// is preserved. `applyEvent` re-applies one recorded event (the replay path).
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
import {
  BUNDLED_CASE,
  caseSeriesToSource,
  type CaseSeries,
  type ViewerSource,
} from "../lib/viewerSource";
import {
  tween,
  lerp,
  type CornerstoneViewerState,
} from "../lib/viewerController";
import { sopUidFromImageId } from "../lib/findingDisplayState";
import { voiTransitionMs } from "../lib/voiTransition";
import {
  normalizeMeasurements,
  type RawAnnotationLike,
} from "../lib/findingMeasurements";
import type { FindingMeasurement, RecordedEvent, ViewerEvent } from "../lib/types";
import {
  WINDOW_PRESETS,
  FULL_DYNAMIC_ID,
  presetsForModality,
  type WindowPreset,
} from "../lib/windowPresets";
import { cn } from "@/components/ui/cn";
import {
  Activity,
  ChevronDown,
  Circle,
  Contrast,
  Crosshair,
  Eraser,
  Move,
  MoveUpRight,
  Ruler,
  Settings2,
  Square,
  Layers as LayersIconL,
  RotateCcw,
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
const PRIMARY_TOOLS: { name: string; label: string; annotation?: boolean }[] = [
  { name: "WindowLevel", label: "Window / Level" },
  { name: "Pan", label: "Pan" },
  { name: "Zoom", label: "Zoom" },
  { name: "StackScroll", label: "Scroll" },
  { name: "Length", label: "Length", annotation: true },
  { name: "Angle", label: "Angle", annotation: true },
  { name: "EllipticalROI", label: "Ellipse ROI", annotation: true },
  { name: "RectangleROI", label: "Rectangle ROI", annotation: true },
  { name: "Probe", label: "Probe", annotation: true },
  { name: "ArrowAnnotate", label: "Arrow", annotation: true },
];

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
  getProperties: () => { voiRange?: { lower: number; upper: number }; invert?: boolean };
  setProperties: (p: { voiRange?: { lower: number; upper: number }; invert?: boolean }) => void;
  getZoom: () => number;
  setZoom: (z: number) => void;
  getPan: () => [number, number];
  setPan: (p: [number, number]) => void;
  worldToCanvas?: (p: [number, number, number]) => [number, number];
  canvasToWorld?: (p: [number, number]) => [number, number, number];
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
  /** Adjust window width/center (VOI). Duration auto-adapts unless overridden. */
  setWindow: (windowWidth: number, windowCenter: number, durationMs?: number) => void;
  /** Set inversion explicitly (record/replay + toolbar). */
  setInvert: (value: boolean) => void;
  /** Reset camera + VOI to the series defaults (fit). */
  reset: () => void;
  /** Re-apply ONE recorded event verbatim (the replay path — snaps, no tween). */
  applyEvent: (e: RecordedEvent) => void;
  /** Current slice / VOI / SOP — primes recordings and finding landings. */
  getStartState: () => {
    sliceIndex: number;
    ww?: number;
    wc?: number;
    sopInstanceUID?: string;
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
}

function voiToWwWc(voi?: { lower: number; upper: number }): { ww: number; wc: number } | null {
  if (!voi) return null;
  return { ww: voi.upper - voi.lower, wc: (voi.upper + voi.lower) / 2 };
}
function wwWcToVoi(ww: number, wc: number): { lower: number; upper: number } {
  return { lower: wc - ww / 2, upper: wc + ww / 2 };
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

export default function CornerstoneViewer({
  source = BUNDLED_CASE,
  series,
  activeSeriesIndex = 0,
  onSeriesChange,
  controls,
  showToolbar = true,
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
  /** Hide the demo toolbar/status line (driven/student mode). */
  showToolbar?: boolean;
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
  // Whether the annotation tools are enabled. Default ENABLED — we only flip to
  // disabled once we POSITIVELY confirm a study has no pixel spacing (e.g. the
  // bundled sample). This avoids the false-negative that killed the tools on
  // real wadors/uploaded studies before their plane metadata had resolved.
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true);
  const destroyToolGroupRef = useRef<(id: string) => void>(() => {});

  const presets = presetsForModality(modality);

  useEffect(() => {
    let disposed = false;
    let renderingEngine: { destroy: () => void } | null = null;
    let detachListeners: () => void = () => {};
    const toolGroupId = `flowrad-tg-${instanceId}`;

    (async () => {
      if (started.current || !elementRef.current) return;
      started.current = true;

      try {
        const core = await import("@cornerstonejs/core");
        const loader = await import("@cornerstonejs/dicom-image-loader");
        const tools = await import("@cornerstonejs/tools");

        await core.init();
        await tools.init();
        await loader.init({ maxWebWorkers: 4 });

        setStatus("Loading series…");
        const imageIds = await buildImageIds(initialSource);
        if (disposed || !elementRef.current) return;

        const renderingEngineId = `flowrad-engine-${instanceId}`;
        const viewportId = `FLOWRAD_STACK_${instanceId}`;
        const engine = new core.RenderingEngine(renderingEngineId);
        renderingEngine = engine;

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
        const loadStack = async (ids: string[]): Promise<void> => {
          await viewport.setStack(ids, Math.floor(ids.length / 2));
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
        viewportRef.current = viewport;
        // Record which series is loaded so switches no-op on the active one.
        loadedSeriesIndexRef.current = seriesRef.current ? activeSeriesIndex : -1;

        // --- Record: emit ordered viewer state changes ----------------------
        // We read CURRENT values off the viewport in the handler (never trust
        // the event-detail shape across Cornerstone versions). Camera/VOI are
        // throttled ~50ms; order is preserved (latest value wins per window).
        const emit = (e: ViewerEvent) => onEventRef.current?.(e);

        let lastCamEmit = 0;
        let lastVoiEmit = 0;
        const THROTTLE = 50;

        const emitSlice = () => {
          const vp = viewportRef.current;
          if (!vp) return;
          emit({ type: "slice", index: vp.getCurrentImageIdIndex() });
        };
        const emitVoi = () => {
          const vp = viewportRef.current;
          if (!vp) return;
          const now = performance.now();
          if (now - lastVoiEmit < THROTTLE) return;
          lastVoiEmit = now;
          const v = voiToWwWc(vp.getProperties().voiRange);
          if (v) emit({ type: "voi", ww: v.ww, wc: v.wc });
        };
        const emitCamera = () => {
          const vp = viewportRef.current;
          if (!vp) return;
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
        el.addEventListener(stackEvt, emitSlice as EventListener);
        el.addEventListener(voiEvt, emitVoi as EventListener);
        el.addEventListener(camEvt, emitCamera as EventListener);
        detachListeners = () => {
          el.removeEventListener(stackEvt, emitSlice as EventListener);
          el.removeEventListener(voiEvt, emitVoi as EventListener);
          el.removeEventListener(camEvt, emitCamera as EventListener);
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
          } catch (err) {
            console.error("CornerstoneViewer switchSeries error", err);
          }
        };
        switchSeriesRef.current = switchSeries;

        resetRef.current = () => {
          cancelTweenRef.current();
          viewport.resetCamera();
          viewport.resetProperties?.();
          viewport.render();
          setInverted(viewport.getProperties().invert ?? false);
          setActivePreset(null);
        };
        clearRef.current = () => {
          annotation.state.removeAllAnnotations();
          viewport.render();
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

        // --- Replay: re-apply ONE recorded event verbatim (snaps, no tween) -
        const applyEvent = (e: RecordedEvent) => {
          const vp = viewportRef.current;
          if (!vp) return;
          cancelTweenRef.current();
          switch (e.type) {
            case "slice": {
              const ids = vp.getImageIds();
              const idx = Math.max(0, Math.min(ids.length - 1, e.index));
              if (idx !== vp.getCurrentImageIdIndex()) void vp.setImageIdIndex(idx);
              break;
            }
            case "voi":
              vp.setProperties({ voiRange: wwWcToVoi(e.ww, e.wc) });
              break;
            case "camera":
              vp.setZoom(e.zoom);
              vp.setPan(e.pan);
              break;
            case "invert":
              vp.setProperties({ invert: e.value });
              setInverted(e.value);
              break;
            case "series": {
              // Replay: switch to the recorded series WITHOUT emitting (this is
              // a programmatic drive). loadStack will render once decoded.
              const list = seriesRef.current;
              const idx = list?.findIndex(
                (s) => s.seriesInstanceUID === e.seriesInstanceUID
              );
              if (list && idx != null && idx >= 0) void switchSeries(idx, false);
              return; // render happens inside loadStack after the new stack loads
            }
            // cursor/annotation are overlay-only — not viewer state.
          }
          vp.render();
        };

        const getStartState = (): {
          sliceIndex: number;
          ww?: number;
          wc?: number;
          sopInstanceUID?: string;
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
          return {
            sliceIndex: idx,
            ww: v?.ww,
            wc: v?.wc,
            sopInstanceUID: sop,
          };
        };

        // --- Smooth (interpolated) driving for the guided tour --------------
        // Adaptive: small ΔWW/WC scrolls like a radiologist; large preset jumps snap.
        const setWindow = (ww: number, wc: number, durationMs?: number): void => {
          const vp = viewportRef.current;
          if (!vp) return;
          const from = voiToWwWc(vp.getProperties().voiRange) ?? { ww, wc };
          const ms =
            durationMs ?? voiTransitionMs(from.ww, from.wc, ww, wc);
          cancelTweenRef.current();
          if (ms <= 0) {
            vp.setProperties({ voiRange: wwWcToVoi(ww, wc) });
            vp.render();
            return;
          }
          cancelTweenRef.current = tween(ms, (e) => {
            vp.setProperties({
              voiRange: wwWcToVoi(lerp(from.ww, ww, e), lerp(from.wc, wc, e)),
            });
            vp.render();
          });
        };

        const applyPreset = (p: WindowPreset | null) => {
          if (!p) {
            // Full dynamic: reset to the series' own VOI.
            const vp = viewportRef.current;
            cancelTweenRef.current();
            vp?.resetProperties?.();
            vp?.render();
            setActivePreset(FULL_DYNAMIC_ID);
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
              : (["Length", "EllipticalROI", "RectangleROI", "Probe"] as const).flatMap(
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

        const handle: CornerstoneControls = {
          ready: true,
          imageCount: imageIds.length,
          showState: showStateFn,
          setWindow,
          setInvert: (v: boolean) => invertRef.current(v),
          reset: () => resetRef.current(),
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
            if (list && idx != null && idx >= 0) void switchSeriesRef.current(idx, false);
          },
        };
        if (controls) controls.current = handle;
        onReady?.(handle);

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
      detachListeners();
      viewportRef.current = null;
      loadedSeriesIndexRef.current = -1;
      // Allow the effect to FULLY re-initialize on a source change (the engine
      // is torn down here). Without this reset a new source would destroy the
      // engine and the re-run would early-return, leaving a blank viewport.
      started.current = false;
      if (controls) controls.current = null;
      try {
        renderingEngine?.destroy();
      } catch {
        /* ignore */
      }
      destroyToolGroupRef.current(toolGroupId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

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
  useEffect(() => {
    if (!presetOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!presetMenuRef.current?.contains(e.target as Node)) setPresetOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresetOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [presetOpen]);

  const activePresetLabel =
    activePreset === FULL_DYNAMIC_ID
      ? "Full dynamic"
      : WINDOW_PRESETS.find((p) => p.id === activePreset)?.label ?? "W/L";

  // Floating PACS-style toolbar — shown in BOTH demo and driven modes.
  const toolbar = (
    <div className="pointer-events-auto absolute left-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-xl border border-strong/60 bg-elevated/85 p-1.5 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-elevated/55 surface-hairline">
      {/* Brand mark */}
      <span className="flex select-none items-center gap-1.5 pl-1 pr-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md border border-strong bg-elevated text-accent">
          <Activity className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden="true" />
        </span>
        <span className="hidden font-display text-[11px] font-semibold tracking-tight text-primary sm:inline">
          FlowRad
        </span>
      </span>
      <span className="mx-0.5 h-6 w-px bg-strong/60" />

      {PRIMARY_TOOLS.map((t) => {
        // Annotation tools stay enabled by default; we only disable (never hide)
        // them on a study we've confirmed has no pixel spacing, with a tooltip
        // that explains why.
        const blocked = !!t.annotation && !annotationsEnabled;
        return (
          <ToolButton
            key={t.name}
            label={
              blocked
                ? `${t.label} — this study has no pixel spacing for measurements`
                : t.label
            }
            active={activeTool === t.name}
            disabled={!ready || blocked}
            onClick={() => setLeftToolRef.current(t.name)}
          >
            <ToolIcon name={t.name} />
          </ToolButton>
        );
      })}

      <span className="mx-0.5 h-6 w-px bg-strong/70" />

      {/* Window/Level preset menu */}
      <div className="relative" ref={presetMenuRef}>
        <button
          type="button"
          disabled={!ready}
          aria-haspopup="menu"
          aria-expanded={presetOpen}
          aria-label="Window/Level presets"
          onClick={() => setPresetOpen((o) => !o)}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-all duration-150",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
            "disabled:cursor-not-allowed disabled:opacity-40",
            presetOpen || activePreset
              ? "bg-accent/15 text-accent"
              : "text-secondary hover:bg-surface hover:text-primary"
          )}
        >
          <ToolIcon name="Preset" />
          <span className="max-w-[6rem] truncate tabular-nums">{activePresetLabel}</span>
          <ChevronDown className="h-3 w-3" strokeWidth={2.2} aria-hidden="true" />
        </button>
        {presetOpen && (
          <div
            role="menu"
            aria-label="Window/Level presets"
            className="absolute left-0 top-full z-30 mt-1.5 w-48 origin-top-left animate-fade-up overflow-hidden rounded-xl border border-strong/70 bg-elevated/95 p-1 shadow-lg backdrop-blur"
          >
            <PresetItem
              label="Full dynamic"
              hint="series default"
              active={activePreset === FULL_DYNAMIC_ID}
              onClick={() => {
                applyPresetRef.current(null);
                setPresetOpen(false);
              }}
            />
            <span className="my-1 block h-px bg-strong/50" />
            {presets.map((p) => (
              <PresetItem
                key={p.id}
                label={p.label}
                hint={`${p.ww} / ${p.wc}`}
                active={activePreset === p.id}
                onClick={() => {
                  applyPresetRef.current(p);
                  setPresetOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <span className="mx-0.5 h-6 w-px bg-strong/70" />

      <ToolButton label="Invert" active={inverted} disabled={!ready} onClick={() => invertRef.current()}>
        <ToolIcon name="Invert" />
      </ToolButton>
      <ToolButton label="Reset view" disabled={!ready} onClick={() => resetRef.current()}>
        <ToolIcon name="Reset" />
      </ToolButton>
      <ToolButton label="Clear annotations" disabled={!ready} onClick={() => clearRef.current()}>
        <ToolIcon name="Clear" />
      </ToolButton>
    </div>
  );

  return (
    <div className={cn("relative", showToolbar ? "w-full" : "h-full w-full", className)}>
      <div
        ref={elementRef}
        className={cn(
          "bg-imaging",
          showToolbar
            ? "aspect-square w-full overflow-hidden rounded-xl border border-subtle"
            : "absolute inset-0"
        )}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="DICOM viewer"
        role="img"
      />
      {toolbar}
      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-md bg-elevated/80 px-3 py-1.5 text-xs text-muted backdrop-blur">
            {status}
          </span>
        </div>
      )}
      {showToolbar && (
        <p className="mt-2 text-xs text-muted">
          Wheel scroll · right-drag zoom · middle-drag pan · left button = selected tool
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

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
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
        "flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-accent text-accent-foreground shadow-sm"
          : "text-secondary hover:bg-overlay hover:text-primary active:scale-95"
      )}
    >
      {children}
    </button>
  );
}

function PresetItem({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active ? "bg-accent/15 text-accent" : "text-secondary hover:bg-surface hover:text-primary"
      )}
    >
      <span className="font-medium">{label}</span>
      <span className="tabular-nums text-muted">{hint}</span>
    </button>
  );
}

// PACS toolbar glyphs, mapped to lucide icons. Each tool keeps its name; only
// the rendered glyph changed (no Cornerstone tool binding is touched).
const TOOL_ICONS: Record<string, LucideIcon> = {
  WindowLevel: Contrast,
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
  Invert: Contrast,
  Reset: RotateCcw,
  Clear: Eraser,
};

function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS[name];
  if (!Icon) return null;
  return <Icon className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />;
}
