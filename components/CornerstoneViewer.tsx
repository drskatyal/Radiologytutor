"use client";

// Self-hosted Cornerstone3D stack viewer — the "Our Viewer" of FlowRad Learn.
// It owns the full feature set we get from rendering DICOM ourselves: scroll,
// window/level, zoom, pan, native annotations, AND — crucially — programmatic,
// SMOOTHLY INTERPOLATED driving of the camera/VOI/slice for the guided student
// walk-through (the whole point of self-hosting vs a cross-origin iframe).
//
// Two modes, one component:
//   • Demo (default): the original toolbar + status line. Unchanged behavior,
//     used by /cornerstone.
//   • Driven: pass `controls` (a ref) + `showToolbar={false}` and the student
//     session drives the viewport via the imperative handle below.
//
// Mouse: wheel = scroll, right-drag = zoom, middle-drag = pan. The LEFT button
// runs whichever tool is picked in the toolbar (window/level by default).
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
import { cn } from "@/components/ui/cn";

// Tools selectable on the LEFT mouse button. Pan/Zoom also keep their
// middle/right bindings so the usual PACS mouse scheme still works.
const PRIMARY_TOOLS: { name: string; label: string }[] = [
  { name: "WindowLevel", label: "Window / Level" },
  { name: "Pan", label: "Pan" },
  { name: "Zoom", label: "Zoom" },
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
 * Imperative handle the student session uses to drive the viewer. All numeric
 * transitions (VOI/zoom/pan) are interpolated with requestAnimationFrame for
 * smooth, cinematic step changes; slice changes snap (decoding a new slice).
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
  /** Reset camera + VOI to the series defaults (fit). */
  reset: () => void;
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
  onReady,
  className,
}: {
  source?: ViewerSource;
  /** Pass a ref to receive the imperative drive handle (student session). */
  controls?: MutableRefObject<CornerstoneControls | null>;
  /** Hide the demo toolbar/status line (driven/student mode). */
  showToolbar?: boolean;
  /** Fired once the series is loaded and the viewport is drivable. */
  onReady?: (controls: CornerstoneControls) => void;
  /** Wrapper class (the viewer fills it; imaging surface stays pure black). */
  className?: string;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  // Stable handle the toolbar uses to switch the left-button tool after init.
  const setLeftToolRef = useRef<(name: string) => void>(() => {});
  const resetRef = useRef<() => void>(() => {});
  const clearRef = useRef<() => void>(() => {});
  // Live viewport + the most recent rAF tween cancel fn (so we never overlap).
  const viewportRef = useRef<DrivableViewport | null>(null);
  const cancelTweenRef = useRef<() => void>(() => {});
  const invertRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState("Initializing viewer…");
  const [activeTool, setActiveTool] = useState("WindowLevel");
  const [ready, setReady] = useState(false);
  const [inverted, setInverted] = useState(false);

  useEffect(() => {
    let disposed = false;
    let renderingEngine: { destroy: () => void } | null = null;
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

        // Left button: pick from the toolbar (default window/level). Pan and
        // Zoom keep their middle/right bindings even when not the left tool.
        const setLeftTool = (name: string) => {
          for (const { name: t } of PRIMARY_TOOLS) {
            if (t === name) {
              const extra =
                t === "Pan"
                  ? [{ mouseButton: MouseBindings.Auxiliary }]
                  : t === "Zoom"
                  ? [{ mouseButton: MouseBindings.Secondary }]
                  : [];
              tg.setToolActive(t, {
                bindings: [{ mouseButton: MouseBindings.Primary }, ...extra],
              });
            } else if (t === "Pan") {
              tg.setToolActive("Pan", { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
            } else if (t === "Zoom") {
              tg.setToolActive("Zoom", { bindings: [{ mouseButton: MouseBindings.Secondary }] });
            } else {
              tg.setToolPassive(t);
            }
          }
          setActiveTool(name);
        };
        setLeftTool("WindowLevel");
        setLeftToolRef.current = setLeftTool;

        resetRef.current = () => {
          cancelTweenRef.current();
          viewport.resetCamera();
          viewport.resetProperties?.();
          viewport.render();
        };
        clearRef.current = () => {
          annotation.state.removeAllAnnotations();
          viewport.render();
        };
        invertRef.current = () => {
          const cur = viewport.getProperties().invert ?? false;
          viewport.setProperties({ invert: !cur });
          viewport.render();
          setInverted(!cur);
        };

        // --- Build the imperative drive handle ------------------------------
        const setWindow = (
          ww: number,
          wc: number,
          durationMs = 500
        ): void => {
          const vp = viewportRef.current;
          if (!vp) return;
          const from = voiToWwWc(vp.getProperties().voiRange) ?? { ww, wc };
          cancelTweenRef.current();
          cancelTweenRef.current = tween(durationMs, (e) => {
            const w = lerp(from.ww, ww, e);
            const c = lerp(from.wc, wc, e);
            vp.setProperties({ voiRange: wwWcToVoi(w, c) });
            vp.render();
          });
        };

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

          // Capture starts for the interpolated fields.
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
          reset: () => resetRef.current(),
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

  // Floating PACS-style icon toolbar — shown in BOTH demo and driven modes.
  const toolbar = (
    <div className="pointer-events-auto absolute left-2 top-2 z-20 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-0.5 rounded-xl border border-strong/70 bg-elevated/85 p-1 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-elevated/60">
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
      <span className="mx-0.5 h-5 w-px bg-strong/70" />
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
