"use client";

// Self-hosted Cornerstone3D stack viewer — the "Our Viewer" half of the
// Pacsbin ⇄ Ours toggle. Demonstrates the full feature set we own once we
// render DICOM ourselves: scroll, window/level, zoom, pan, and native
// annotations (length, angle, arrow, ROI, probe).
//
// Mouse: wheel = scroll, right-drag = zoom, middle-drag = pan. The LEFT button
// runs whichever tool is picked in the toolbar (window/level by default).
//
// Must be loaded with `next/dynamic({ ssr:false })` — uses WebGL/DOM/workers.

import { useEffect, useRef, useState } from "react";
import createImageIdsAndCacheMetaData from "../lib/createImageIdsAndCacheMetaData";
import { BUNDLED_CASE, type ViewerSource } from "../lib/viewerSource";

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
}: {
  source?: ViewerSource;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  // Stable handle the toolbar uses to switch the left-button tool after init.
  const setLeftToolRef = useRef<(name: string) => void>(() => {});
  const resetRef = useRef<() => void>(() => {});
  const clearRef = useRef<() => void>(() => {});
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

        const viewport = engine.getViewport(viewportId) as {
          setStack: (ids: string[], i?: number) => Promise<void>;
          render: () => void;
          resetCamera: () => void;
          resetProperties?: () => void;
        };
        await viewport.setStack(imageIds, Math.floor(imageIds.length / 2));
        viewport.render();

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
          viewport.resetCamera();
          viewport.resetProperties?.();
          viewport.render();
        };
        clearRef.current = () => {
          annotation.state.removeAllAnnotations();
          viewport.render();
        };

        setReady(true);
        setStatus(`${imageIds.length} images loaded`);
      } catch (err) {
        console.error("CornerstoneViewer error", err);
        setStatus(`Error: ${(err as Error).message}`);
      }
    })();

    return () => {
      disposed = true;
      try {
        renderingEngine?.destroy();
      } catch {
        /* ignore */
      }
    };
  }, [source]);

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
