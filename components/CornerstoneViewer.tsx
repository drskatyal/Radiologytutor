"use client";

// Self-hosted Cornerstone3D stack viewer — the "Our Viewer" half of the
// Pacsbin ⇄ Ours toggle. Renders a DICOM series from any DICOMweb (WADO-RS)
// source with scroll / window-level / zoom / pan tools.
//
// Must be loaded with `next/dynamic({ ssr:false })` — it uses WebGL, the DOM,
// and web workers, none of which exist during server rendering.

import { useEffect, useRef, useState } from "react";
import createImageIdsAndCacheMetaData from "../lib/createImageIdsAndCacheMetaData";

// A public DICOMweb CT used by the official Cornerstone examples — lets us spike
// the viewer with a real study before our own Orthanc backend exists.
export const DEMO_SOURCE = {
  wadoRsRoot: "https://d3t6nz73ql33tx.cloudfront.net/dicomweb",
  StudyInstanceUID:
    "1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463",
  SeriesInstanceUID:
    "1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561",
};

export interface CornerstoneViewerProps {
  wadoRsRoot?: string;
  StudyInstanceUID?: string;
  SeriesInstanceUID?: string;
}

export default function CornerstoneViewer({
  wadoRsRoot = DEMO_SOURCE.wadoRsRoot,
  StudyInstanceUID = DEMO_SOURCE.StudyInstanceUID,
  SeriesInstanceUID = DEMO_SOURCE.SeriesInstanceUID,
}: CornerstoneViewerProps) {
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
        // Dynamic imports keep Cornerstone out of the server bundle entirely.
        const core = await import("@cornerstonejs/core");
        const loader = await import("@cornerstonejs/dicom-image-loader");
        const tools = await import("@cornerstonejs/tools");

        await core.init();
        await tools.init();
        await loader.init({ maxWebWorkers: 1 });

        setStatus("Loading series…");
        const imageIds = await createImageIdsAndCacheMetaData({
          StudyInstanceUID,
          SeriesInstanceUID,
          wadoRsRoot,
        });
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

        setStatus(`${imageIds.length} images — scroll to navigate`);
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
  }, [wadoRsRoot, StudyInstanceUID, SeriesInstanceUID]);

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
