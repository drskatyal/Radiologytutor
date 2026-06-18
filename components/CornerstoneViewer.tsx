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
import { BUNDLED_CASE, type ViewerSource } from "../lib/viewerSource";
import {
  tween,
  lerp,
  type CornerstoneViewerState,
} from "../lib/viewerController";
import type { RecordedEvent, ViewerEvent } from "../lib/types";
import {
  WINDOW_PRESETS,
  FULL_DYNAMIC_ID,
  presetsForModality,
  type WindowPreset,
} from "../lib/windowPresets";
import { cn } from "@/components/ui/cn";

// Tools selectable on the LEFT mouse button. Pan/Zoom/Scroll also keep their
// wheel/middle/right bindings so the usual PACS mouse scheme still works.
const PRIMARY_TOOLS: { name: string; label: string }[] = [
  { name: "WindowLevel", label: "Window / Level" },
  { name: "Pan", label: "Pan" },
  { name: "Zoom", label: "Zoom" },
  { name: "StackScroll", label: "Scroll" },
  { name: "Length", label: "Length" },
  { name: "Angle", label: "Angle" },
  { name: "EllipticalROI", label: "Ellipse ROI" },
  { name: "RectangleROI", label: "Rectangle ROI" },
  { name: "Probe", label: "Probe" },
  { name: "ArrowAnnotate", label: "Arrow" },
];

// Minimal structural type for the bits of a StackViewport we drive.
interface DrivableViewport {
  setStack: (ids: string[], i?: number) => Promise<void>;
  render: () => void;
  resetCamera: () => void;
  resetProperties?: () => void;
  getImageIds: () => string[];
  getCurrentImageIdIndex: () => number;
  setImageIdIndex: (i: number) => Promise<void> | void;
  getProperties: () => { voiRange?: { lower: number; upper: number }; invert?: boolean };
  setProperties: (p: { voiRange?: { lower: number; upper: number }; invert?: boolean }) => void;
  getZoom: () => number;
  setZoom: (z: number) => void;
  getPan: () => [number, number];
  setPan: (p: [number, number]) => void;
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
  /** Adjust window width/center (VOI), interpolated. */
  setWindow: (windowWidth: number, windowCenter: number, durationMs?: number) => void;
  /** Set inversion explicitly (record/replay + toolbar). */
  setInvert: (value: boolean) => void;
  /** Reset camera + VOI to the series defaults (fit). */
  reset: () => void;
  /** Re-apply ONE recorded event verbatim (the replay path — snaps, no tween). */
  applyEvent: (e: RecordedEvent) => void;
  /** Current slice/window — used to prime a recording/replay. */
  getStartState: () => { sliceIndex: number; ww?: number; wc?: number };
}

function voiToWwWc(voi?: { lower: number; upper: number }): { ww: number; wc: number } | null {
  if (!voi) return null;
  return { ww: voi.upper - voi.lower, wc: (voi.upper + voi.lower) / 2 };
}
function wwWcToVoi(ww: number, wc: number): { lower: number; upper: number } {
  return { lower: wc - ww / 2, upper: wc + ww / 2 };
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
  controls,
  showToolbar = true,
  modality,
  onReady,
  onEvent,
  className,
}: {
  source?: ViewerSource;
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

  const [status, setStatus] = useState("Initializing viewer…");
  const [activeTool, setActiveTool] = useState("WindowLevel");
  const [ready, setReady] = useState(false);
  const [inverted, setInverted] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);

  const presets = presetsForModality(modality);

  useEffect(() => {
    let disposed = false;
    let renderingEngine: { destroy: () => void } | null = null;
    let detachListeners: () => void = () => {};
    const toolGroupId = "flowrad-tg";

    (async () => {
      if (started.current || !elementRef.current) return;
      started.current = true;

      try {
        const core = await import("@cornerstonejs/core");
        const loader = await import("@cornerstonejs/dicom-image-loader");
        const tools = await import("@cornerstonejs/tools");

        await core.init();
        await tools.init();
        await loader.init({ maxWebWorkers: 1 });

        setStatus("Loading series…");
        const imageIds = await buildImageIds(source);
        if (disposed || !elementRef.current) return;

        const renderingEngineId = "flowrad-engine";
        const viewportId = "FLOWRAD_STACK";
        const engine = new core.RenderingEngine(renderingEngineId);
        renderingEngine = engine;

        engine.enableElement({
          viewportId,
          type: core.Enums.ViewportType.STACK,
          element: elementRef.current,
        });

        const viewport = engine.getViewport(viewportId) as unknown as DrivableViewport;
        await viewport.setStack(imageIds, Math.floor(imageIds.length / 2));
        viewport.render();
        viewportRef.current = viewport;

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

        // Register every tool once, then add them all to the group.
        [
          WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
          LengthTool, AngleTool, ArrowAnnotateTool,
          RectangleROITool, EllipticalROITool, ProbeTool,
        ].forEach((T) => addTool(T));

        ToolGroupManager.destroyToolGroup(toolGroupId);
        const tg = ToolGroupManager.createToolGroup(toolGroupId);
        if (!tg) throw new Error("could not create tool group");
        [
          WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
          LengthTool, AngleTool, ArrowAnnotateTool,
          RectangleROITool, EllipticalROITool, ProbeTool,
        ].forEach((T) => tg.addTool(T.toolName));
        tg.addViewport(viewportId, renderingEngineId);

        const { MouseBindings } = toolsEnums;
        // Fixed bindings: wheel = scroll, right = zoom, middle = pan.
        tg.setToolActive(StackScrollTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Wheel }],
        });
        tg.setToolActive(ZoomTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Secondary }],
        });
        tg.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Auxiliary }],
        });

        // Left button: pick from the toolbar (default window/level). Pan, Zoom
        // and Scroll keep their wheel/middle/right bindings even when not the
        // left tool, so the standard PACS mouse scheme is always live.
        const setLeftTool = (name: string) => {
          for (const { name: t } of PRIMARY_TOOLS) {
            if (t === name) {
              const extra =
                t === "Pan"
                  ? [{ mouseButton: MouseBindings.Auxiliary }]
                  : t === "Zoom"
                  ? [{ mouseButton: MouseBindings.Secondary }]
                  : t === "StackScroll"
                  ? [{ mouseButton: MouseBindings.Wheel }]
                  : [];
              tg.setToolActive(t, {
                bindings: [{ mouseButton: MouseBindings.Primary }, ...extra],
              });
            } else if (t === "Pan") {
              tg.setToolActive("Pan", { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
            } else if (t === "Zoom") {
              tg.setToolActive("Zoom", { bindings: [{ mouseButton: MouseBindings.Secondary }] });
            } else if (t === "StackScroll") {
              tg.setToolActive("StackScroll", { bindings: [{ mouseButton: MouseBindings.Wheel }] });
            } else {
              tg.setToolPassive(t);
            }
          }
          setActiveTool(name);
        };
        setLeftTool("WindowLevel");
        setLeftToolRef.current = setLeftTool;

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
            // cursor/annotation are overlay-only — not viewer state.
          }
          vp.render();
        };

        const getStartState = (): { sliceIndex: number; ww?: number; wc?: number } => {
          const vp = viewportRef.current;
          if (!vp) return { sliceIndex: 0 };
          const v = voiToWwWc(vp.getProperties().voiRange);
          return { sliceIndex: vp.getCurrentImageIdIndex(), ww: v?.ww, wc: v?.wc };
        };

        // --- Smooth (interpolated) driving for the guided tour --------------
        const setWindow = (ww: number, wc: number, durationMs = 500): void => {
          const vp = viewportRef.current;
          if (!vp) return;
          const from = voiToWwWc(vp.getProperties().voiRange) ?? { ww, wc };
          cancelTweenRef.current();
          cancelTweenRef.current = tween(durationMs, (e) => {
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
          setWindow(p.ww, p.wc, 320);
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
          if (state.sliceFraction != null) {
            const ids = vp.getImageIds();
            const idx = Math.max(
              0,
              Math.min(ids.length - 1, Math.round(state.sliceFraction * (ids.length - 1)))
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

          return new Promise<void>((resolve) => {
            cancelTweenRef.current = tween(
              durationMs,
              (e) => {
                if (fromVoi && toWw != null && toWc != null) {
                  vp.setProperties({
                    voiRange: wwWcToVoi(lerp(fromVoi.ww, toWw, e), lerp(fromVoi.wc, toWc, e)),
                  });
                }
                vp.setZoom(lerp(fromZoom, toZoom, e));
                vp.setPan([lerp(fromPan[0], toPan[0], e), lerp(fromPan[1], toPan[1], e)]);
                vp.render();
              },
              resolve
            );
          });
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
      if (controls) controls.current = null;
      try {
        renderingEngine?.destroy();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

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
    <div className="pointer-events-auto absolute left-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-xl border border-strong/70 bg-elevated/85 p-1.5 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-elevated/55">
      {/* Brand mark */}
      <span className="flex select-none items-center gap-1.5 pl-1 pr-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3.5 w-3.5">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 4v16M4 12h16" strokeLinecap="round" opacity="0.55" />
          </svg>
        </span>
        <span className="hidden text-[11px] font-semibold tracking-tight text-primary sm:inline">
          FlowRad
        </span>
      </span>
      <span className="mx-0.5 h-6 w-px bg-strong/70" />

      {PRIMARY_TOOLS.map((t) => (
        <ToolButton
          key={t.name}
          label={t.label}
          active={activeTool === t.name}
          disabled={!ready}
          onClick={() => setLeftToolRef.current(t.name)}
        >
          <ToolIcon name={t.name} />
        </ToolButton>
      ))}

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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
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
          : "text-secondary hover:bg-surface hover:text-primary active:scale-95"
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

function ToolIcon({ name }: { name: string }) {
  const p = {
    className: "h-4 w-4",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "WindowLevel":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "Pan":
      return (
        <svg {...p}>
          <path d="M12 3v18M3 12h18M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5" />
        </svg>
      );
    case "Zoom":
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-3.6-3.6M11 8.5v5M8.5 11h5" />
        </svg>
      );
    case "StackScroll":
      return (
        <svg {...p}>
          <rect x="6" y="3" width="12" height="18" rx="3" />
          <path d="M12 7v6M9.5 9.5 12 7l2.5 2.5" />
        </svg>
      );
    case "Length":
      return (
        <svg {...p}>
          <path d="M5 19 19 5M5.5 15.5l3 3M9.5 11.5l3 3M13.5 7.5l3 3" />
        </svg>
      );
    case "Angle":
      return (
        <svg {...p}>
          <path d="M4 20h16M4 20 18 6M4 20a9 9 0 0 0 5-7" />
        </svg>
      );
    case "EllipticalROI":
      return (
        <svg {...p}>
          <ellipse cx="12" cy="12" rx="9" ry="6" />
        </svg>
      );
    case "RectangleROI":
      return (
        <svg {...p}>
          <rect x="4" y="6" width="16" height="12" rx="1.5" />
        </svg>
      );
    case "Probe":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      );
    case "ArrowAnnotate":
      return (
        <svg {...p}>
          <path d="M5 19 19 5M12 5h7v7" />
        </svg>
      );
    case "Preset":
      return (
        <svg {...p}>
          <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
          <circle cx="16" cy="8" r="2" fill="currentColor" stroke="none" />
          <circle cx="8" cy="16" r="2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "Invert":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "Reset":
      return (
        <svg {...p}>
          <path d="M4 12a8 8 0 1 1 2.4 5.7M4 12V7M4 12h5" />
        </svg>
      );
    case "Clear":
      return (
        <svg {...p}>
          <path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" />
        </svg>
      );
    default:
      return null;
  }
}
