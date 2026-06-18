"use client";

// Self-hosted Cornerstone3D stack viewer — the "Our Viewer" half of the
// Pacsbin ⇄ Ours toggle. Renders a DICOM series with scroll / window-level /
// zoom / pan tools.
//
// Two source modes:
//   - "wadouri": load a DICOM file bundled in /public (no server, no CORS) —
//     this is the default so a case ALWAYS renders.
//   - "wadors":  load a series from a DICOMweb server (our future Orthanc, or
//     a public demo source).
//
// Must be loaded with `next/dynamic({ ssr:false })` — uses WebGL/DOM/workers.

import { useEffect, useRef, useState } from "react";
import createImageIdsAndCacheMetaData from "../lib/createImageIdsAndCacheMetaData";
import { BUNDLED_CASE, type ViewerSource } from "../lib/viewerSource";

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
  const [status, setStatus] = useState("Initializing viewer…");

  useEffect(() => {
    let disposed = false;
    let renderingEngine: { destroy: () => void } | null = null;

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
          Enums: toolsEnums,
        } = tools;

        addTool(WindowLevelTool);
        addTool(PanTool);
        addTool(ZoomTool);
        addTool(StackScrollTool);

        const tg = ToolGroupManager.createToolGroup("flowrad-tg");
        if (tg) {
          tg.addTool(WindowLevelTool.toolName);
          tg.addTool(PanTool.toolName);
          tg.addTool(ZoomTool.toolName);
          tg.addTool(StackScrollTool.toolName);
          tg.addViewport(viewportId, renderingEngineId);

          const { MouseBindings } = toolsEnums;
          tg.setToolActive(WindowLevelTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Primary }],
          });
          tg.setToolActive(PanTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Auxiliary }],
          });
          tg.setToolActive(ZoomTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Secondary }],
          });
          tg.setToolActive(StackScrollTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Wheel }],
          });
        }

        setStatus(`${imageIds.length} images — scroll to navigate, drag to window-level`);
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
      <div
        ref={elementRef}
        style={{ width: "100%", aspectRatio: "1 / 1", background: "#000" }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <p style={{ fontSize: 12, color: "#9aa", margin: 0 }}>{status}</p>
    </div>
  );
}
