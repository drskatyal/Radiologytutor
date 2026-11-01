// One grid cell: a Cornerstone stack viewport with the corner overlay, edge
// orientation letters, a slice scrollbar and cine.
//
// Progressive by design: the series can grow while it is on screen (the scan
// streams headers), and the viewport re-stacks in place, keeping the image the
// reader is looking at.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { clampCineFps } from "@/lib/cinePlayer";
import type { DesktopHeader, ViewerSeries, ViewerStudy } from "../types";
import { formatDicomDate, formatDicomTime, formatPersonName } from "../study";
import { addViewportToGroup, getEngine, removeViewportFromGroups, STACK_GROUP, type Engine } from "./engine";
import { registerHandle, type ViewportHandle, type ViewportReadout } from "./handles";
import { edgeLabels, type EdgeLabels, type Vec3 } from "./orientation";
import { voiRangeOf, wwwcOf } from "./presets";
import { ensureSuv } from "./suv";
import { isTauri, previewUrlFor } from "../platform";
import { verifyPainted, type PaintHealth } from "./paintCheck";

export interface StackViewportProps {
  cellKey: string;
  viewportId: string;
  series: ViewerSeries | null;
  study: ViewerStudy | null;
  active: boolean;
  showOverlay: boolean;
  /** True while the scan is still streaming this series in. */
  growing: boolean;
  onActivate: () => void;
  onDropSeries: (seriesUid: string) => void;
  onDoubleClick: () => void;
  onFirstPaint?: (ms: number, health: PaintHealth) => void;
  /** Teaching / screen sharing: no name, ID or birth date in the overlay. */
  hidePatient?: boolean;
  /** Fired when the instant Rust-rendered preview is on screen. */
  onPreview?: () => void;
}

interface Readout extends ViewportReadout {
  /** Small cell (3×3 grids): essentials only, so text never covers anatomy. */
  compact?: boolean;
  edges?: EdgeLabels;
  header?: DesktopHeader;
  rows?: number;
  columns?: number;
}

function fmt(n: number | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toFixed(digits);
}

function StackViewportImpl({
  cellKey,
  viewportId,
  series,
  study,
  active,
  showOverlay,
  growing,
  onActivate,
  onDropSeries,
  onDoubleClick,
  onFirstPaint,
  hidePatient = false,
  onPreview,
}: StackViewportProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const loadedRef = useRef<{ uid: string; ids: string[] } | null>(null);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const [readout, setReadout] = useState<Readout | null>(null);
  const [loading, setLoading] = useState(false);
  /** Series whose first Cornerstone frame is on screen; until then the preview shows. */
  const [paintedUid, setPaintedUid] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [cine, setCine] = useState<{ playing: boolean; fps: number }>({ playing: false, fps: 15 });
  const cineRef = useRef(cine);
  cineRef.current = cine;
  const rafRef = useRef(0);
  const [engineReady, setEngineReady] = useState(false);
  const readoutRef = useRef<Readout | null>(null);
  readoutRef.current = readout;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewport = useCallback((): any => {
    const engine = engineRef.current;
    if (!engine) return null;
    try {
      return engine.renderingEngine.getViewport(viewportId) ?? null;
    } catch {
      return null;
    }
  }, [viewportId]);

  const refreshReadout = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const vp = viewport();
      const s = seriesRef.current;
      if (!vp || !s) return;
      const index = vp.getCurrentImageIdIndex?.() ?? 0;
      const props = vp.getProperties?.() ?? {};
      const voi = props.voiRange ? wwwcOf(props.voiRange) : undefined;
      const camera = vp.getCamera?.();
      let zoom: number | undefined;
      try {
        const data = vp.getImageData?.();
        const spacing = data?.spacing?.[1] ?? 1;
        const cssHeight = elementRef.current?.clientHeight ?? 0;
        if (camera?.parallelScale && cssHeight) zoom = (cssHeight * spacing) / (2 * camera.parallelScale);
      } catch {
        /* image not decoded yet */
      }
      const edges =
        camera?.viewUp && camera?.viewPlaneNormal
          ? edgeLabels(camera.viewUp as Vec3, camera.viewPlaneNormal as Vec3)
          : undefined;
      const header = s.headers[index];
      const el = elementRef.current;
      setReadout({
        compact: !!el && (el.clientWidth < 520 || el.clientHeight < 380),
        index,
        count: s.imageIds.length,
        ww: voi?.ww,
        wc: voi?.wc,
        zoom,
        rotation: vp.getViewPresentation?.()?.rotation,
        edges,
        header,
        rows: header?.rows,
        columns: header?.columns,
      });
    });
  }, [viewport]);

  // Enable the element once; tear down on unmount.
  useEffect(() => {
    let disposed = false;
    const element = elementRef.current!;
    let resizeObserver: ResizeObserver | null = null;
    (async () => {
      // Let the instant preview land first (it needs the main thread for a
      // frame or two); the engine's parse+init would otherwise block it.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const engine = await getEngine();
      if (disposed) return;
      engineRef.current = engine;
      const { core } = engine;
      engine.renderingEngine.enableElement({
        viewportId,
        element,
        type: core.Enums.ViewportType.STACK,
        defaultOptions: { background: [0, 0, 0] },
      });
      addViewportToGroup(engine, STACK_GROUP, viewportId);
      const Events = core.Enums.Events;
      const onRender = () => refreshReadout();
      element.addEventListener(Events.IMAGE_RENDERED, onRender);
      element.addEventListener(Events.STACK_NEW_IMAGE, onRender);
      element.addEventListener(Events.VOI_MODIFIED, onRender);
      element.addEventListener(Events.CAMERA_MODIFIED, onRender);
      resizeObserver = new ResizeObserver(() => {
        try {
          engine.renderingEngine.resize(true, false);
        } catch {
          /* element detached mid-layout */
        }
        refreshReadout();
      });
      resizeObserver.observe(element);
      setEngineReady(true);
    })();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      cancelAnimationFrame(rafRef.current);
      const engine = engineRef.current;
      if (engine) {
        try {
          engine.tools.utilities.cine.stopClip(element);
        } catch {
          /* no clip */
        }
        removeViewportFromGroups(engine, viewportId);
        try {
          engine.renderingEngine.disableElement(viewportId);
        } catch {
          /* already gone */
        }
      }
      loadedRef.current = null;
    };
  }, [viewportId, refreshReadout]);

  // Load / grow the stack.
  useEffect(() => {
    if (!engineReady) return;
    const vp = viewport();
    if (!vp) return;
    if (!series || series.imageIds.length === 0) {
      loadedRef.current = null;
      setReadout(null);
      return;
    }
    const previous = loadedRef.current;
    const sameSeries = previous?.uid === series.uid;
    if (sameSeries && previous.ids.length === series.imageIds.length) return;
    const ids = series.imageIds;
    let index = 0;
    if (sameSeries) {
      // Growing: keep the image the reader is on.
      const current = previous.ids[vp.getCurrentImageIdIndex?.() ?? 0];
      const at = current ? ids.indexOf(current) : -1;
      index = at >= 0 ? at : 0;
    }
    loadedRef.current = { uid: series.uid, ids };
    const started = performance.now();
    if (!sameSeries) {
      setLoading(true);
      setError(null);
      const engine = engineRef.current;
      try {
        engine?.tools.utilities.cine.stopClip(elementRef.current!);
      } catch {
        /* none */
      }
      setCine({ playing: false, fps: clampCineFps(series.frameRate ?? 15) });
    }
    const voi = sameSeries ? vp.getProperties?.().voiRange : null;
    const camera = sameSeries ? vp.getCamera?.() : null;
    let suv: "suv" | "raw" = "raw";
    ensureSuv(series)
      .then((state) => {
        suv = state;
        return vp.setStack(ids, index);
      })
      .then(() => {
        if (loadedRef.current?.ids !== ids) return;
        if (sameSeries) {
          if (voi) vp.setProperties({ voiRange: voi });
          if (camera) vp.setCamera(camera);
        } else {
          const h = series.headers[index];
          if (series.modality === "PT") {
            // Header windows are in raw counts; after SUV scaling they are meaningless.
            if (suv === "suv") vp.setProperties({ voiRange: { lower: 0, upper: 5 } });
          } else if (h?.windowWidth && h.windowWidth > 1 && h.windowCenter != null) {
            vp.setProperties({ voiRange: voiRangeOf(h.windowWidth, h.windowCenter) });
          }
        }
        vp.render();
        if (!sameSeries) {
          // Never call it painted until real pixels are on screen: a GPU path
          // that renders black (some drivers' 16-bit textures) falls back to
          // CPU rendering here instead of leaving the reader a black box.
          void verifyPainted(engineRef.current, vp, elementRef.current, ids, index).then((health) => {
            if (loadedRef.current?.ids !== ids) return;
            onFirstPaint?.(performance.now() - started, health);
            setPaintedUid(series.uid);
          });
        }
        setLoading(false);
        refreshReadout();
      })
      .catch((e: unknown) => {
        if (loadedRef.current?.ids !== ids) return;
        setLoading(false);
        setError(e instanceof Error ? e.message : "This image could not be decoded.");
      });
  }, [engineReady, series, viewport, refreshReadout, onFirstPaint]);

  // Imperative handle for toolbar + keyboard.
  useEffect(() => {
    if (!engineReady || !elementRef.current) return;
    const element = elementRef.current;
    const render = () => viewport()?.render();
    const handle: ViewportHandle = {
      viewportId,
      element,
      seriesUid: series?.uid ?? null,
      setVoi(ww, wc) {
        const vp = viewport();
        if (!vp) return;
        vp.setProperties({ voiRange: voiRangeOf(ww, wc) });
        render();
      },
      resetVoi() {
        const vp = viewport();
        if (!vp) return;
        const h = seriesRef.current?.headers[vp.getCurrentImageIdIndex?.() ?? 0];
        vp.resetProperties?.();
        if (h?.windowWidth && h.windowWidth > 1 && h.windowCenter != null) {
          vp.setProperties({ voiRange: voiRangeOf(h.windowWidth, h.windowCenter) });
        }
        render();
      },
      invert() {
        const vp = viewport();
        if (!vp) return;
        vp.setProperties({ invert: !vp.getProperties().invert });
        render();
      },
      zoomTo(scale) {
        const vp = viewport();
        if (!vp) return;
        if (scale === "fit") {
          vp.resetCamera({ resetPan: true, resetZoom: true });
        } else {
          const spacing = vp.getImageData?.()?.spacing?.[1] ?? 1;
          const cssHeight = element.clientHeight || 1;
          vp.setCamera({ parallelScale: (cssHeight * spacing) / (2 * scale) });
        }
        render();
      },
      zoomBy(factor) {
        const vp = viewport();
        if (!vp) return;
        vp.setZoom(vp.getZoom() * factor);
        render();
      },
      pan(dx, dy) {
        const vp = viewport();
        if (!vp) return;
        const [x, y] = vp.getPan();
        const zoom = vp.getZoom() || 1;
        vp.setPan([x - dx / zoom, y - dy / zoom]);
        render();
      },
      rotate(degrees) {
        const vp = viewport();
        if (!vp) return;
        const current = vp.getViewPresentation?.()?.rotation ?? 0;
        vp.setViewPresentation({ rotation: (current + degrees + 360) % 360 });
        render();
      },
      flip(axis) {
        const vp = viewport();
        if (!vp) return;
        const cam = vp.getCamera();
        if (axis === "h") vp.setCamera({ flipHorizontal: !cam.flipHorizontal });
        else vp.setCamera({ flipVertical: !cam.flipVertical });
        render();
      },
      reset() {
        const vp = viewport();
        if (!vp) return;
        vp.resetCamera({ resetPan: true, resetZoom: true, resetToCenter: true });
        vp.setViewPresentation?.({ rotation: 0, flipHorizontal: false, flipVertical: false });
        handle.resetVoi();
        vp.setProperties({ invert: false });
        render();
      },
      step(delta) {
        const vp = viewport();
        if (!vp) return;
        const count = vp.getImageIds?.().length ?? 0;
        const next = Math.max(0, Math.min(count - 1, (vp.getCurrentImageIdIndex?.() ?? 0) + delta));
        void vp.setImageIdIndex(next);
      },
      goTo(where) {
        const vp = viewport();
        if (!vp) return;
        const count = vp.getImageIds?.().length ?? 0;
        const target = where === "first" ? 0 : where === "last" ? count - 1 : where;
        void vp.setImageIdIndex(Math.max(0, Math.min(count - 1, target)));
      },
      toggleCine() {
        const engine = engineRef.current;
        if (!engine || (seriesRef.current?.imageIds.length ?? 0) < 2) return;
        const { cine: cineUtil } = engine.tools.utilities;
        if (cineRef.current.playing) {
          cineUtil.stopClip(element);
          setCine((c) => ({ ...c, playing: false }));
        } else {
          cineUtil.playClip(element, { framesPerSecond: cineRef.current.fps, loop: true });
          setCine((c) => ({ ...c, playing: true }));
        }
      },
      setCineFps(fps) {
        const next = clampCineFps(fps);
        const engine = engineRef.current;
        setCine((c) => ({ ...c, fps: next }));
        if (engine && cineRef.current.playing) {
          const { cine: cineUtil } = engine.tools.utilities;
          cineUtil.stopClip(element);
          cineUtil.playClip(element, { framesPerSecond: next, loop: true });
        }
      },
      cine: () => cineRef.current,
      renderFrame(i) {
        const vp = viewport();
        const engine = engineRef.current;
        if (!vp || !engine) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const event = engine.core.Enums.Events.IMAGE_RENDERED;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            element.removeEventListener(event, onRendered);
            resolve();
          };
          const onRendered = () => requestAnimationFrame(finish);
          element.addEventListener(event, onRendered);
          window.setTimeout(finish, 3000);
          if ((vp.getCurrentImageIdIndex?.() ?? -1) === i) {
            vp.render();
          } else {
            void vp.setImageIdIndex(i);
          }
        });
      },
      readout: () => readoutRef.current,
    };
    return registerHandle(cellKey, handle);
  }, [engineReady, cellKey, viewportId, series?.uid, viewport]);

  const h = readout?.header;
  const patientLine = useMemo(() => {
    const p = study?.patient;
    if (!p) return [];
    if (hidePatient) return ["Patient hidden", [p.sex, p.age].filter(Boolean).join(" · ")].filter(Boolean);
    return [
      formatPersonName(p.name) || "Unnamed patient",
      [p.id, p.sex, p.age || formatDicomDate(p.birthDate)].filter(Boolean).join(" · "),
    ];
  }, [study, hidePatient]);

  const count = series?.imageIds.length ?? 0;
  const index = readout?.index ?? 0;
  const thumbTop = count > 1 ? (index / (count - 1)) * 100 : 0;

  const onTrackPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1 && event.type !== "pointerdown") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    viewport()?.setImageIdIndex(Math.round(fraction * (count - 1)));
  };

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden bg-imaging",
        "outline outline-1 -outline-offset-1",
        // Exactly one active viewport: a 2px accent border; the rest a thin neutral one.
        active ? "outline-2 -outline-offset-2 outline-accent" : "outline-subtle",
        dragOver && "outline-2 outline-accent-bright"
      )}
      onPointerDownCapture={onActivate}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-radlearn-series")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        const uid = e.dataTransfer.getData("application/x-radlearn-series");
        setDragOver(false);
        if (uid) {
          e.preventDefault();
          onDropSeries(uid);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={elementRef} className="cs-viewport absolute inset-0" data-viewport-id={viewportId} data-has-series={series ? "1" : undefined} />

      {/* Instant first image: rendered by Rust in a few ms, shown while the
          engine starts, replaced by the real viewport on its first paint. */}
      {series && isTauri && paintedUid !== series.uid && previewFailed !== series.uid && series.headers[0] && (
        <img
          key={series.uid}
          src={previewUrlFor(series.headers[0].fileId)}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={onPreview}
          onError={() => setPreviewFailed(series.uid)}
          className="pointer-events-none absolute inset-0 h-full w-full bg-imaging object-contain"
        />
      )}

      {!series && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted">
          Drag a series here
        </div>
      )}

      {loading && (
        <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs text-white">
          <Spinner size="sm" label="Loading series" />
          Loading…
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-lg bg-black/80 p-3 text-center text-xs text-danger">
          {error}
        </div>
      )}

      {series && showOverlay && (
        <div className="pointer-events-none absolute inset-0 select-none p-2 font-sans text-[11px] leading-[1.35] text-white/90 text-halo tabular-nums">
          <div className="absolute left-2 top-2">
            {(readout?.compact ? patientLine.slice(0, 1) : patientLine).map((line) => (
              <div key={line} className={line === patientLine[0] ? "font-semibold text-white" : undefined}>
                {line}
              </div>
            ))}
          </div>
          <div className="absolute right-6 top-2 text-right">
            {!readout?.compact && (
              <>
                {study?.institution && <div>{study.institution}</div>}
                <div>{study?.description || "Study"}</div>
                <div>
                  {formatDicomDate(study?.date)} {formatDicomTime(study?.time)}
                </div>
              </>
            )}
            <div className="max-w-[40ch] truncate text-white">{series.description}</div>
          </div>
          <div className="absolute bottom-2 left-2">
            <div className="text-white">
              Im {index + 1} / {count}
              {growing && <span className="text-warning"> · loading</span>}
            </div>
            {!readout?.compact && h?.sliceLocation != null && <div>Loc {fmt(h.sliceLocation, 1)} mm</div>}
            {!readout?.compact && h?.sliceThickness != null && <div>Thk {fmt(h.sliceThickness, 1)} mm</div>}
            <div>
              W {fmt(readout?.ww)} · L {fmt(readout?.wc)}
            </div>
          </div>
          <div className="absolute bottom-2 right-6 text-right">
            <div>
              {series.modality}
              {series.number != null ? ` · Se ${series.number}` : ""}
            </div>
            {!readout?.compact && readout?.columns && readout.rows && (
              <div>
                {readout.columns} × {readout.rows}
              </div>
            )}
            {readout?.zoom != null && <div>Zoom {Math.round(readout.zoom * 100)}%</div>}
            {cine.playing && <div className="text-accent-bright">▶ {cine.fps} fps</div>}
          </div>
          {readout?.edges && (
            <>
              <span className="absolute left-1/2 top-2 -translate-x-1/2 font-semibold text-warning/90">{readout.edges.top}</span>
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 font-semibold text-warning/90">{readout.edges.bottom}</span>
              <span className="absolute left-2 top-1/2 -translate-y-1/2 font-semibold text-warning/90">{readout.edges.left}</span>
              <span className="absolute right-6 top-1/2 -translate-y-1/2 font-semibold text-warning/90">{readout.edges.right}</span>
            </>
          )}
        </div>
      )}

      {series && count > 1 && (
        <div
          role="scrollbar"
          aria-label="Image position"
          aria-orientation="vertical"
          aria-valuemin={1}
          aria-valuemax={count}
          aria-valuenow={index + 1}
          className="group absolute bottom-2 right-1 top-2 w-3 cursor-pointer"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            onTrackPointer(e);
          }}
          onPointerMove={onTrackPointer}
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/15 group-hover:bg-white/30" />
          {/* Dynamic position — the one place inline style is the right tool. */}
          <div
            className="absolute left-0 h-6 w-3 -translate-y-1/2 rounded-full bg-white/40 group-hover:bg-accent-bright"
            style={{ top: `${thumbTop}%` }}
          />
        </div>
      )}
    </div>
  );
}

export const StackViewport = memo(StackViewportImpl);
