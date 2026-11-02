// Phase 2, P2.2 (docs/NATIVE_RENDERER.md): a 2D viewport drawn by the native
// renderer. Same props and the same imperative handle as StackViewport, so
// App, the toolbar, keyboard, voice and the series browser drive it unchanged.
//
// The element is a transparent hole in the page: Rust draws the slice under
// it (cell rect via nativeLayout), the page draws the overlay text, the
// active frame and (P2.3) annotations on top. Input lands here and goes to
// Rust as view changes, coalesced to one call in flight per viewport.
//
// Display and navigation (P2.2): slices (wheel, drag, keys, cine), window/
// level, zoom, pan, rotate, flip, invert, reset. Tools (P2.3): every
// measurement / ROI / probe / arrow / eraser tool on an SVG layer
// (NativeAnnotationLayer), and Magnify as a second native viewport at 3×.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyOrientation,
  getScrollPreferences,
  normalizeRotation,
  orientationMarkers,
  orientMarkers,
  slicesForNotch,
} from "@flowrad/viewer-core";
import { cn } from "@/components/ui/cn";
import { ViewerContextMenu } from "@/components/viewer/ViewerContextMenu";
import { Spinner } from "@/components/ui/Spinner";
import { invoke } from "../platform";
import { registerHandle, type ViewportHandle, type ViewportReadout } from "../viewer/handles";
import { ViewportFrame, type StackViewportProps } from "../viewer/StackViewport";
import { noteActivity } from "../activity";
import { cursorForTool } from "../viewer/toolCursor";
import { onNativeLayoutApplied, registerNativeCell, scheduleNativeLayout } from "./nativeLayout";
import { dragModeFor, resolveWheel } from "../viewer/mouseBindings";
import { toCell, toImage, transformFor, type NativeTransform, type NativeView } from "./transform";
import NativeAnnotationLayer, { isAnnotationTool } from "./NativeAnnotationLayer";

export interface NativeShow {
  index: number;
  count: number;
  cached: boolean;
  decodeMs: number;
  frameMs: number;
  totalMs: number;
  rows: number;
  cols: number;
  window: [number, number];
  view: NativeView;
  transform: NativeTransform;
  defaultWindow: [number, number] | null;
}

type Patch = Partial<{
  index: number;
  wl: [number, number];
  zoom: number;
  pan: [number, number];
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  invert: boolean;
  resetCamera: boolean;
}>;

/** Navigation tools the native viewport handles itself (P2.2). */
const NAV_TOOLS = new Set(["WindowLevel", "Pan", "Zoom", "StackScroll"]);

interface Props extends StackViewportProps {
  /** The app's left-button tool. */
  tool?: string;
}

export default function NativeStackViewport({
  cellKey,
  viewportId,
  series,
  active,
  cellIndex,
  dropHover,
  showOverlay,
  hidePatient = false,
  onActivate,
  onDropSeries,
  onDoubleClick,
  onFirstPaint,
  onAnnotationsDeleted,
  imageMenu,
  onMenuCommand,
  tool = "StackScroll",
}: Props) {
  // Right-click menu (#111, shared contextMenu.ts): a right press that did not
  // drag (a right drag windows, MOUSE_DEFAULTS) opens it at the pointer.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const rightMoved = useRef(false);
  const elementRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<NativeShow | null>(null);
  const shownRef = useRef<NativeShow | null>(null);
  shownRef.current = shown;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cine, setCine] = useState({ playing: false, fps: 15 });
  const cineRef = useRef(cine);
  cineRef.current = cine;

  // Register the cell's rectangle with the native layout.
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    return registerNativeCell(cellKey, el);
  }, [cellKey]);

  // ── one view change in flight; later ones coalesce into the next ──
  const pending = useRef<Patch | null>(null);
  const inflight = useRef(false);
  const waiters = useRef<(() => void)[]>([]);
  const pump = useCallback(async () => {
    if (inflight.current || !pending.current) return;
    const patch = pending.current;
    pending.current = null;
    inflight.current = true;
    const done = waiters.current.splice(0);
    try {
      const r = await invoke<NativeShow>("native_cell_view", { id: cellKey, patch });
      setShown(r);
      noteActivity();
    } catch (e) {
      setError(String(e));
    } finally {
      inflight.current = false;
      done.forEach((d) => d());
      if (pending.current) void pump();
    }
  }, [cellKey]);
  const change = useCallback(
    (patch: Patch): Promise<void> => {
      pending.current = { ...(pending.current ?? {}), ...patch };
      const p = new Promise<void>((resolve) => waiters.current.push(resolve));
      void pump();
      return p;
    },
    [pump]
  );

  // The cell's size changed (layout applied): refresh the view so the
  // transform the overlays and tools use matches the new size.
  useEffect(() => {
    let size = "";
    return onNativeLayoutApplied(() => {
      const el = elementRef.current;
      if (!el || !shownRef.current) return;
      const next = `${el.clientWidth}x${el.clientHeight}`;
      const t = shownRef.current.transform;
      if (next === size && t.scale > 0) return;
      size = next;
      void change({});
    });
  }, [change]);

  // ── the series ──
  useEffect(() => {
    if (!series || series.headers.length === 0) {
      setShown(null);
      return;
    }
    let cancelled = false;
    const started = performance.now();
    setLoading(true);
    setError(null);
    void invoke<NativeShow>("native_cell_series", {
      id: cellKey,
      fileIds: series.headers.map((h) => h.fileId),
      index: 0,
    })
      .then((r) => {
        if (cancelled) return;
        setShown(r);
        setLoading(false);
        noteActivity();
        // Native paint: the frame was presented when the call returned. Blank
        // detection on this path is the e2e's screen grab, not a canvas readback.
        onFirstPaint?.(performance.now() - started, { maxLum: 255, nonBlank: true, expectVisible: true, renderPath: "gpu" });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // A growing series re-sends its full list (the same cell keeps its slice).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellKey, series?.uid, series?.headers.length]);

  const count = shown?.count ?? 0;
  const goTo = useCallback((i: number) => change({ index: Math.max(0, Math.min(count - 1, i)) }), [change, count]);
  const step = useCallback((d: number) => goTo((shownRef.current?.index ?? 0) + d), [goTo]);

  // ── cine ──
  useEffect(() => {
    if (!cine.playing || count < 2) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (now - last >= 1000 / cineRef.current.fps) {
        last = now;
        const at = shownRef.current?.index ?? 0;
        void change({ index: (at + 1) % count });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cine.playing, count, change]);

  // ── the imperative handle (toolbar, keyboard, voice, export) ──
  const readout = useMemo<ViewportReadout | null>(() => {
    if (!shown || !series) return null;
    return {
      index: shown.index,
      count: shown.count,
      ww: shown.window[1],
      wc: shown.window[0],
      zoom: shown.view.zoom,
      rotation: shown.view.rotation,
    };
  }, [shown, series]);
  const readoutRef = useRef(readout);
  readoutRef.current = readout;

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    const handle: ViewportHandle = {
      viewportId,
      element: el,
      seriesUid: series?.uid ?? null,
      setVoi: (ww, wc) => void change({ wl: [wc, ww] }),
      resetVoi: () => {
        const d = shownRef.current?.defaultWindow;
        if (d) void change({ wl: [d[0], d[1]] });
      },
      invert: () => void change({ invert: !shownRef.current?.view.invert }),
      zoomTo: (scale) => void change({ zoom: scale === "fit" ? 1 : scale, ...(scale === "fit" ? { pan: [0, 0] as [number, number] } : {}) }),
      zoomBy: (f) => void change({ zoom: (shownRef.current?.view.zoom ?? 1) * f }),
      pan: (dx, dy) => {
        const p = shownRef.current?.view.pan ?? [0, 0];
        void change({ pan: [p[0] + dx, p[1] + dy] });
      },
      rotate: (deg) => void change({ rotation: normalizeRotation((shownRef.current?.view.rotation ?? 0) + deg) }),
      // Screen flips: at 90° / 270° the image-space flip alone would mirror the
      // other axis (viewer-core viewOrientation.ts applyOrientation).
      flip: (axis) => {
        const v = shownRef.current?.view;
        if (!v) return;
        const next = applyOrientation({ rotation: v.rotation, flipH: v.flipH, flipV: v.flipV }, axis === "h" ? "flip:h" : "flip:v");
        void change(next);
      },
      resetOrientation: () => void change({ rotation: 0, flipH: false, flipV: false }),
      reset: () => {
        const d = shownRef.current?.defaultWindow;
        void change({ resetCamera: true, ...(d ? { wl: [d[0], d[1]] as [number, number] } : {}) });
      },
      step: (d) => void step(d),
      goTo: (where) => void goTo(where === "first" ? 0 : where === "last" ? count - 1 : where),
      toggleCine: () => setCine((c) => ({ ...c, playing: !c.playing })),
      setCineFps: (fps) => setCine((c) => ({ ...c, fps: Math.max(1, Math.min(60, fps)) })),
      cine: () => cineRef.current,
      readout: () => readoutRef.current,
      renderFrame: (i) => change({ index: i }),
    };
    return registerHandle(cellKey, handle);
  }, [cellKey, viewportId, series?.uid, change, step, goTo, count]);

  // ── input: wheel scrolls; left = the app's tool; right = zoom; middle = pan ──
  const notchRun = useRef({ at: 0, n: 0 });
  const onWheel = (e: React.WheelEvent) => {
    if (!shown) return;
    // Ctrl+wheel zooms a plain image (WHEEL_DEFAULTS; slab is a reformat's).
    if (resolveWheel({ ctrl: e.ctrlKey || e.metaKey })?.command !== "scroll") {
      void change({ zoom: shown.view.zoom * Math.exp(-Math.sign(e.deltaY) * 0.1) });
      return;
    }
    const now = performance.now();
    const run = now - notchRun.current.at < 140 ? notchRun.current.n + 1 : 1;
    notchRun.current = { at: now, n: run };
    void step(Math.sign(e.deltaY) * slicesForNotch(getScrollPreferences(), run));
  };
  const drag = useRef<{ x: number; y: number; button: number; ctrl: boolean; start: NativeShow; acc: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    onActivate();
    if (!shown) return;
    if (e.button === 0 && tool === "Magnify") {
      e.currentTarget.setPointerCapture(e.pointerId);
      startLens(e);
      return;
    }
    // Annotation tools are handled by the annotation layer (it stops the event).
    if (e.button === 0 && !NAV_TOOLS.has(tool)) return;
    if (e.button === 2) rightMoved.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, button: e.button, ctrl: e.ctrlKey || e.metaKey, start: shown, acc: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (lens) moveLens(e);
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.button === 2 && Math.abs(dx) + Math.abs(dy) > 3) rightMoved.current = true;
    // Right drag = window / level, middle = pan, as on the JS path (engine.ts
    // MouseBindings.Secondary / Auxiliary), the toolbar tooltip and the F1
    // sheet. (0.8.1 zoomed on right drag: HP report.) Zoom is Ctrl+wheel / Z.
    const mode = dragModeFor(d.button, tool, { ctrl: d.ctrl });
    const v = d.start.view;
    if (mode === "WindowLevel") {
      const k = Math.max(1, v.wl[1] / 256);
      void change({ wl: [v.wl[0] + dy * k, Math.max(1, v.wl[1] + dx * k)] });
    } else if (mode === "Pan") {
      void change({ pan: [v.pan[0] + dx, v.pan[1] + dy] });
    } else if (mode === "Zoom") {
      void change({ zoom: v.zoom * Math.exp(-dy / 200) });
    } else if (mode === "StackScroll") {
      const per = getScrollPreferences().dragPixelsPerSlice ?? Math.max(2, 400 / Math.max(count, 1));
      const target = d.start.index + Math.trunc(dy / per);
      if (target !== d.acc) {
        d.acc = target;
        void goTo(target);
      }
    }
  };
  const endDrag = () => {
    drag.current = null;
    setLens(null);
  };

  // ── Magnify: a 160 px lens, a second native viewport at 3× the cell's scale ──
  const LENS = 160;
  const [lens, setLens] = useState<{ x: number; y: number } | null>(null);
  const lensRef = useRef<HTMLDivElement>(null);
  const lensId = `${cellKey}:lens`;
  const lensView = (cx: number, cy: number) => {
    const s = shownRef.current;
    if (!s) return null;
    const q = toImage(s.transform, cx, cy);
    const turned = s.view.rotation % 180 === 90;
    const [iw, ih] = turned ? [s.rows, s.cols] : [s.cols, s.rows];
    const zoom = (3 * s.transform.scale) / Math.min(LENS / iw, LENS / ih);
    const t0 = transformFor({ ...s.view, zoom, pan: [0, 0] }, s.cols, s.rows, LENS, LENS);
    const c0 = toCell(t0, q[0], q[1]);
    return { ...s.view, zoom, pan: [LENS / 2 - c0[0], LENS / 2 - c0[1]] as [number, number] };
  };
  const local = (e: React.PointerEvent) => {
    const r = elementRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const startLens = (e: React.PointerEvent) => {
    if (!series || !shownRef.current) return;
    const [x, y] = local(e);
    setLens({ x, y });
    const v = lensView(x, y);
    void invoke("native_cell_series", { id: lensId, fileIds: series.headers.map((h) => h.fileId), index: shownRef.current.index }).then(
      () => v && invoke("native_cell_view", { id: lensId, patch: { wl: v.wl, zoom: v.zoom, pan: v.pan, rotation: v.rotation, flipH: v.flipH, flipV: v.flipV, invert: v.invert } }),
      () => undefined
    );
  };
  const moveLens = (e: React.PointerEvent) => {
    const [x, y] = local(e);
    setLens({ x, y });
    const v = lensView(x, y);
    if (v) void invoke("native_cell_view", { id: lensId, patch: { zoom: v.zoom, pan: v.pan } }).catch(() => undefined);
  };
  // The lens moves without resizing: re-send the layout on every move.
  useEffect(() => {
    if (lens) scheduleNativeLayout();
  }, [lens]);
  useEffect(() => {
    if (!lens || !lensRef.current) return;
    return registerNativeCell(lensId, lensRef.current);
    // Registered once per press; moves only reposition the element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!lens, lensId]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(t);
  }, [notice]);

  const header = series?.headers[shown?.index ?? 0];
  const baseEdges = orientationMarkers(header?.imageOrientationPatient);
  const edges = baseEdges && shown ? orientMarkers(baseEdges, shown.view) : null;
  return (
    <div
      ref={elementRef}
      data-native-viewport
      // Image <-> cell mapping valid (after the cell's first layout reached Rust).
      data-native-ready={shown && shown.transform.scale > 0 ? "1" : undefined}
      data-drop-cell={cellIndex}
      data-viewport-id={viewportId}
      role="img"
      aria-label={series ? `${series.description || "Series"}, image ${(shown?.index ?? 0) + 1} of ${count}` : "Empty viewport"}
      // The tool's own cursor (viewer/toolCursor.ts); the body-level rule wins when installed.
      className={cn("relative min-h-0 min-w-0 touch-none select-none overflow-hidden", `tool-cursor-${cursorForTool(tool)}`)}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={(e) => {
        e.preventDefault();
        if (rightMoved.current || !imageMenu) return;
        onActivate();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const uid = e.dataTransfer.getData("application/x-flowrad-series") || e.dataTransfer.getData("text/plain");
        if (uid) onDropSeries(uid);
      }}
    >
      {showOverlay && shown && series && (
        <>
          <div className="pointer-events-none absolute left-2 top-2 space-y-0.5 text-[11px] leading-tight text-white/85 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]">
            {!hidePatient && header?.patientName && <div className="font-medium">{String(header.patientName).replace(/\^/g, " ")}</div>}
            <div>{series.description || `Series ${series.number ?? ""}`}</div>
          </div>
          <div className="pointer-events-none absolute bottom-2 left-2 space-y-0.5 text-[11px] tabular-nums leading-tight text-white/85 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]">
            <div>
              Im {shown.index + 1} / {shown.count}
            </div>
            <div>
              W {Math.round(shown.window[1])} L {Math.round(shown.window[0])}
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-2 right-2 text-[11px] tabular-nums text-white/70 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]">
            Zoom {shown.view.zoom.toFixed(2)}× · native
          </div>
          {edges && (
            // Edge letters follow rotate / flip (viewer-core orientMarkers).
            <div data-orientation-markers className="pointer-events-none absolute inset-0 text-xs font-semibold text-white/80 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]">
              <span data-edge="top" className="absolute left-1/2 top-1.5 -translate-x-1/2">{edges.top}</span>
              <span data-edge="bottom" className="absolute bottom-1.5 left-1/2 -translate-x-1/2">{edges.bottom}</span>
              <span data-edge="left" className="absolute left-1.5 top-1/2 -translate-y-1/2">{edges.left}</span>
              <span data-edge="right" className="absolute right-1.5 top-1/2 -translate-y-1/2">{edges.right}</span>
            </div>
          )}
        </>
      )}
      {shown && series && (
        <NativeAnnotationLayer
          cellKey={cellKey}
          seriesUid={series.uid}
          imageIndex={shown.index}
          transform={shown.transform}
          spacing={pixelSpacingOf(header)}
          tool={tool}
          active={active}
          onDeleted={(n) => n > 0 && onAnnotationsDeleted?.(n, "one")}
        />
      )}
      {lens && (
        <div
          ref={lensRef}
          aria-hidden
          className="pointer-events-none absolute z-20 rounded-md border-2 border-white/80 shadow-lg"
          // Dynamic: the lens follows the pointer.
          style={{ left: lens.x - LENS / 2, top: lens.y - LENS / 2, width: LENS, height: LENS }}
        />
      )}
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner label="Loading the series" />
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded-md bg-black/80 p-3 text-center text-xs text-danger">
          This series could not be shown natively: {error}
        </div>
      )}
      {notice && (
        <div role="status" className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-md bg-black/80 px-2 py-1 text-xs text-white">
          {notice}
        </div>
      )}
      {!series && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted">Drop a series here</div>}
      {menuAt && imageMenu && (
        <ViewerContextMenu
          at={menuAt}
          label="Image"
          entries={imageMenu()}
          onSelect={(command) => {
            setMenuAt(null);
            onMenuCommand?.(command);
          }}
          onClose={() => setMenuAt(null)}
        />
      )}
      <ViewportFrame active={active} hover={dropHover} />
    </div>
  );
}

/** DICOM Pixel Spacing [row, column] mm, or 1 mm when the file has none. */
function pixelSpacingOf(h: { pixelSpacing?: number[] } | undefined): [number, number] {
  const p = h?.pixelSpacing;
  return p && p.length >= 2 && p[0] > 0 && p[1] > 0 ? [p[0], p[1]] : [1, 1];
}
