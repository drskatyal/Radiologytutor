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

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import createImageIdsAndCacheMetaData from "../lib/createImageIdsAndCacheMetaData";
import { BUNDLED_CASE, type ViewerSource } from "../lib/viewerSource";
import {
  tween,
  lerp,
  type CornerstoneViewerState,
} from "../lib/viewerController";

// Tools selectable on the LEFT mouse button (mutually exclusive).
const LEFT_TOOLS: { name: string; label: string }[] = [
  { name: "WindowLevel", label: "Window/Level" },
  { name: "Length", label: "Length" },
  { name: "Angle", label: "Angle" },
  { name: "ArrowAnnotate", label: "Arrow" },
  { name: "RectangleROI", label: "Rectangle" },
  { name: "EllipticalROI", label: "Ellipse" },
  { name: "Probe", label: "Probe" },
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
  getProperties: () => { voiRange?: { lower: number; upper: number } };
  setProperties: (p: { voiRange?: { lower: number; upper: number } }) => void;
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
  const [status, setStatus] = useState("Initializing viewer…");
  const [activeTool, setActiveTool] = useState("WindowLevel");
  const [ready, setReady] = useState(false);

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

        // Left button: pick from the toolbar (default window/level).
        const setLeftTool = (name: string) => {
          for (const { name: t } of LEFT_TOOLS) {
            if (t === name) {
              tg.setToolActive(t, {
                bindings: [{ mouseButton: MouseBindings.Primary }],
              });
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

  // Driven mode: the viewer fills its container; the parent owns the chrome.
  if (!showToolbar) {
    return (
      <div
        ref={elementRef}
        className={className ?? "h-full w-full bg-imaging"}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="DICOM viewer"
        role="img"
      />
    );
  }

  // Demo mode: original inline-styled toolbar + status line (unchanged).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {LEFT_TOOLS.map((t) => (
          <button
            key={t.name}
            disabled={!ready}
            onClick={() => setLeftToolRef.current(t.name)}
            style={toolBtnStyle(activeTool === t.name)}
          >
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button disabled={!ready} onClick={() => resetRef.current()} style={toolBtnStyle(false)}>
          Reset
        </button>
        <button disabled={!ready} onClick={() => clearRef.current()} style={toolBtnStyle(false)}>
          Clear
        </button>
      </div>

      <div
        ref={elementRef}
        style={{ width: "100%", aspectRatio: "1 / 1", background: "#000" }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <p style={{ fontSize: 12, color: "#9aa", margin: 0 }}>
        {status} · wheel = scroll, right-drag = zoom, middle-drag = pan, left = selected tool
      </p>
    </div>
  );
}

function toolBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "5px 10px",
    fontSize: 12,
    borderRadius: 6,
    border: `1px solid ${active ? "#2d6cdf" : "#345"}`,
    background: active ? "#2d6cdf" : "transparent",
    color: active ? "#fff" : "#9aa",
    cursor: "pointer",
  };
}
