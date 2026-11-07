"use client";

// The teacher's ink on the DICOM viewport, in the Recording Studio.
//
// Every stored point is an image-space anchor; each render projects it
// through the LIVE camera (zoom / pan / resize), and an item only draws on
// the image it was drawn on (SOP + frame, else stack index). So a stroke
// stays on its anatomy through zoom, pan, window/level, scroll and reload.
//
// Look: the same hand-drawn marker ink as the tutor (perfect-freehand,
// pressure-tapered, dark halo for bright tissue), in marker yellow. Numbered
// finding markers are a solid badge + label pill.
//
// Interaction: with a sketch tool armed, a capture layer takes the pointer
// (wheel still scrolls the stack — it is forwarded to the viewer). With the
// select tool the layer is inert and the viewer keeps the mouse.

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { useViewFrame } from "@/components/student/useViewFrame";
import { Button, Input, cn } from "@/components/ui";
import {
  arrowStrokes,
  brushOutline,
  INK,
  inkSeed,
  loopOffsets,
  outlinePath,
  partialStroke,
  type Pt,
} from "@/lib/inkStroke";
import type { SketchFrame } from "@/lib/sketchProjection";
import {
  anchorPoint,
  hitTestSketch,
  imageRefFrom,
  itemOnImage,
  revealedPoints,
  SKETCH_LIMITS,
  strokeProgress,
  type SketchView,
} from "@/lib/teacherSketch";
import type { TeacherSketchItem } from "@/lib/types";
import type { UseTeacherSketch } from "./useTeacherSketch";

export interface TeacherSketchLayerHandle {
  /** M: drop a marker at the last pointer position over the image. False if none. */
  dropAtPointer: () => boolean;
}

const PEN_SIZE = 4.2;
const SHAPE_SIZE = 3.6;
const MIN_SEGMENT_PX = 2;

type Draft =
  | { kind: "pen"; pts: Array<Pt & { t: number }>; startedAt: number }
  | { kind: "arrow" | "ellipse"; from: Pt; to: Pt; startedAt: number; shift: boolean };

function viewOf(frame: SketchFrame): SketchView {
  return {
    sliceIndex: frame.sliceIndex,
    seriesInstanceUID: frame.image?.seriesInstanceUID,
    sopInstanceUID: frame.image?.sopInstanceUID,
    frameNumber: frame.image?.frameNumber,
  };
}

function inImage(p: { x_pct: number; y_pct: number } | null): p is { x_pct: number; y_pct: number } {
  return !!p && p.x_pct >= -0.02 && p.x_pct <= 1.02 && p.y_pct >= -0.02 && p.y_pct <= 1.02;
}

function findImagingElement(root: HTMLElement | null): HTMLElement | null {
  let node = root?.parentElement ?? null;
  while (node) {
    const hit = node.querySelector<HTMLElement>("[data-imaging-element]");
    if (hit) return hit;
    node = node.parentElement;
  }
  return null;
}

export const TeacherSketchLayer = forwardRef<
  TeacherSketchLayerHandle,
  {
    sketch: UseTeacherSketch;
    controls: RefObject<CornerstoneControls | null>;
    /** False while the stage replays a take: the pointer stays with the viewer. */
    interactive: boolean;
  }
>(function TeacherSketchLayer({ sketch, controls, interactive }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frame = useViewFrame(controls);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const [textAt, setTextAt] = useState<{ x: number; y: number; x_pct: number; y_pct: number } | null>(null);
  const [textValue, setTextValue] = useState("");
  const erased = useRef(new Set<string>());
  const filterId = useId().replace(/:/g, "");

  const armed = interactive && sketch.tool !== "select" && !sketch.replaying;

  // Track the pointer over the image (for M) without taking the mouse.
  useEffect(() => {
    const host = findImagingElement(rootRef.current)?.parentElement;
    if (!host) return;
    const onMove = (e: PointerEvent) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      hoverRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => {
      hoverRef.current = null;
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, [frame != null]);

  const dropAt = useCallback(
    (x: number, y: number): boolean => {
      const f = frameRef.current;
      if (!f) return false;
      const p = f.unproject(x, y);
      if (!p || p.x_pct < 0 || p.x_pct > 1 || p.y_pct < 0 || p.y_pct > 1) return false;
      return !!sketch.dropMarker(f, p.x_pct, p.y_pct);
    },
    [sketch]
  );

  useImperativeHandle(
    ref,
    () => ({
      dropAtPointer: () => {
        const hover = hoverRef.current;
        return hover ? dropAt(hover.x, hover.y) : false;
      },
    }),
    [dropAt]
  );

  // Progressive replay: keep painting while any stroke is still drawing back.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sketch.replayed.length) return;
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      const busy = sketch.replayed.some((r) => strokeProgress(r.item, now - r.bornAt) < 1);
      setTick((n) => (n + 1) % 1_000_000);
      if (busy) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sketch.replayed]);

  const local = (e: React.PointerEvent | React.MouseEvent): Pt | null => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return null;
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const commitText = () => {
    const f = frameRef.current;
    const at = textAt;
    const body = textValue.trim().slice(0, SKETCH_LIMITS.textChars);
    setTextAt(null);
    setTextValue("");
    if (!f || !at || !body) return;
    sketch.commit({
      op: "add",
      item: {
        id: sketch.newId("text"),
        kind: "text",
        image: imageRefFrom(f.image, f.sliceIndex),
        points: [anchorPoint(at.x_pct, at.y_pct, f.image)],
        text: body,
      },
    });
  };

  const eraseAt = (p: Pt) => {
    const f = frameRef.current;
    if (!f) return;
    const hit = hitTestSketch(
      sketch.items.filter((i) => !erased.current.has(i.id)),
      viewOf(f),
      f.project,
      p.x,
      p.y,
      12
    );
    if (hit) {
      erased.current.add(hit.id);
      sketch.commit({ op: "remove", id: hit.id });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = local(e);
    const f = frameRef.current;
    if (!p || !f) return;
    const img = f.unproject(p.x, p.y);
    if (sketch.tool === "eraser") {
      erased.current = new Set();
      e.currentTarget.setPointerCapture(e.pointerId);
      eraseAt(p);
      setDraft({ kind: "pen", pts: [], startedAt: performance.now() });
      return;
    }
    if (!inImage(img)) return;
    if (sketch.tool === "marker") {
      dropAt(p.x, p.y);
      sketch.setTool("select");
      return;
    }
    if (sketch.tool === "text") {
      // Keep focus for the text box: the browser's mousedown default and the
      // viewer's own pointer-down (refocus the image) would blur it shut.
      e.preventDefault();
      e.stopPropagation();
      if (textAt) commitText();
      setTextAt({ x: p.x, y: p.y, x_pct: img.x_pct, y_pct: img.y_pct });
      setTextValue("");
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (sketch.tool === "pen") setDraft({ kind: "pen", pts: [{ ...p, t: now }], startedAt: now });
    else if (sketch.tool === "arrow" || sketch.tool === "ellipse")
      setDraft({ kind: sketch.tool, from: p, to: p, startedAt: now, shift: e.shiftKey });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const current = draftRef.current;
    if (!current) return;
    const p = local(e);
    if (!p) return;
    if (sketch.tool === "eraser") {
      eraseAt(p);
      return;
    }
    if (current.kind === "pen") {
      const last = current.pts[current.pts.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_SEGMENT_PX) return;
      if (current.pts.length >= SKETCH_LIMITS.pointsPerStroke) return;
      setDraft({ ...current, pts: [...current.pts, { ...p, t: performance.now() }] });
    } else {
      setDraft({ ...current, to: p, shift: e.shiftKey });
    }
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    const current = draftRef.current;
    setDraft(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const f = frameRef.current;
    if (!current || !f || sketch.tool === "eraser") return;
    const ref = imageRefFrom(f.image, f.sliceIndex);
    const drawMs = Math.round(performance.now() - current.startedAt);
    if (current.kind === "pen") {
      if (current.pts.length < 2) return;
      const points = current.pts
        .map((pt) => {
          const img = f.unproject(pt.x, pt.y);
          return img ? anchorPoint(img.x_pct, img.y_pct, f.image, pt.t - current.startedAt) : null;
        })
        .filter((pt): pt is NonNullable<typeof pt> => !!pt);
      if (points.length < 2) return;
      sketch.commit({ op: "add", item: { id: sketch.newId("pen"), kind: "pen", image: ref, points, drawMs } });
      return;
    }
    let to = current.to;
    if (current.kind === "ellipse" && current.shift) {
      const side = Math.max(Math.abs(to.x - current.from.x), Math.abs(to.y - current.from.y));
      to = { x: current.from.x + Math.sign(to.x - current.from.x || 1) * side, y: current.from.y + Math.sign(to.y - current.from.y || 1) * side };
    }
    if (Math.hypot(to.x - current.from.x, to.y - current.from.y) < 6) return;
    const a = f.unproject(current.from.x, current.from.y);
    const b = f.unproject(to.x, to.y);
    if (!a || !b) return;
    sketch.commit({
      op: "add",
      item: {
        id: sketch.newId(current.kind),
        kind: current.kind,
        image: ref,
        points: [anchorPoint(a.x_pct, a.y_pct, f.image, 0), anchorPoint(b.x_pct, b.y_pct, f.image, drawMs)],
        drawMs,
      },
    });
  };

  // Hand the wheel to the viewer so the stack still scrolls while drawing.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const target = findImagingElement(rootRef.current)?.querySelector("canvas") ?? findImagingElement(rootRef.current);
    if (!target) return;
    target.dispatchEvent(
      new WheelEvent("wheel", {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        bubbles: true,
        cancelable: true,
      })
    );
  };

  // Close a pending text box when the tool changes.
  useLayoutEffect(() => {
    if (sketch.tool !== "text" && textAt) commitText();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch.tool]);

  const now = performance.now();
  const born = new Map(sketch.replayed.map((r) => [r.item.id, r.bornAt]));
  const view = frame ? viewOf(frame) : null;
  const visible = frame ? sketch.items.filter((item) => itemOnImage(item, view)) : [];

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-[15]"
      data-testid="teacher-sketch-layer"
      data-tool={sketch.tool}
      data-visible-count={visible.length}
    >
      {frame && frame.width >= 2 && frame.height >= 2 && (
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          width={frame.width}
          height={frame.height}
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          aria-hidden="true"
        >
          <defs>
            <filter id={`${filterId}-halo`} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation={1.6} />
            </filter>
          </defs>
          {visible.map((item) => {
            const bornAt = born.get(item.id);
            const elapsed = bornAt == null ? Number.POSITIVE_INFINITY : now - bornAt;
            return <SketchItemInk key={item.id} item={item} frame={frame} elapsed={elapsed} filterId={filterId} />;
          })}
          {draft && <DraftInk draft={draft} filterId={filterId} />}
        </svg>
      )}

      {frame &&
        visible
          .filter((item) => item.kind === "marker" || item.kind === "text")
          .map((item) => {
            const bornAt = born.get(item.id);
            if (bornAt != null && now - bornAt <= 0) return null;
            const p = item.points[0] ? frame.project(item.points[0].x_pct, item.points[0].y_pct) : null;
            if (!p) return null;
            return item.kind === "marker" ? (
              <MarkerBadge key={item.id} item={item} x={p.x} y={p.y} />
            ) : (
              <TextInk key={item.id} item={item} x={p.x} y={p.y} />
            );
          })}

      {armed && (
        <div
          className={cn(
            "pointer-events-auto absolute inset-0 touch-none",
            sketch.tool === "eraser" ? "cursor-cell" : sketch.tool === "text" ? "cursor-text" : "cursor-crosshair"
          )}
          data-testid="teacher-sketch-capture"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
      )}

      {textAt && (
        <form
          className="pointer-events-auto absolute z-30 flex -translate-y-1/2 items-center gap-1.5"
          style={{ left: textAt.x, top: textAt.y }}
          onSubmit={(e) => {
            e.preventDefault();
            commitText();
          }}
        >
          <Input
            autoFocus
            aria-label="Sketch text"
            value={textValue}
            maxLength={SKETCH_LIMITS.textChars}
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setTextAt(null);
                setTextValue("");
              }
            }}
            onBlur={commitText}
            placeholder="Type, then Enter"
            className="h-8 w-56 border-ink/60 bg-black/85 text-sm text-white placeholder:text-white/50 focus:border-ink focus:bg-black/90"
          />
        </form>
      )}

      {sketch.labelling && frame && (
        <MarkerLabelPopover
          key={sketch.labelling.id}
          item={sketch.labelling}
          frame={frame}
          onSave={(text) => sketch.setLabel(sketch.labelling!.id, text)}
          onCancel={sketch.closeLabel}
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Ink
// ---------------------------------------------------------------------------

function InkPath({ points, size, filterId, complete = true }: { points: Pt[]; size: number; filterId: string; complete?: boolean }) {
  const outline = brushOutline(points, { size, complete });
  const d = outlinePath(outline);
  if (!d) return null;
  return (
    <g>
      <path d={d} fill="#000" opacity={0.55} stroke="#000" strokeWidth={2.4} filter={`url(#${filterId}-halo)`} />
      <path d={d} fill={INK.authored} />
    </g>
  );
}

function ellipsePoints(a: Pt, b: Pt, seed: number): Pt[] {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.max(2, Math.abs(b.x - a.x) / 2);
  const ry = Math.max(2, Math.abs(b.y - a.y) / 2);
  return loopOffsets(seed).map((o) => ({ x: cx + o.x * rx, y: cy + o.y * ry }));
}

function SketchItemInk({
  item,
  frame,
  elapsed,
  filterId,
}: {
  item: TeacherSketchItem;
  frame: SketchFrame;
  elapsed: number;
  filterId: string;
}) {
  if (item.kind === "text" || item.kind === "marker") return null;
  const progress = strokeProgress(item, elapsed);
  const shown = revealedPoints(item, elapsed);
  const project = (p: { x_pct: number; y_pct: number }) => frame.project(p.x_pct, p.y_pct);
  const seed = inkSeed(item.id);
  const common = { "data-testid": `teacher-stroke`, "data-kind": item.kind, "data-done": progress >= 1 ? "true" : "false" };

  if (item.kind === "pen") {
    const pts = shown.map(project).filter((p): p is Pt => !!p);
    if (pts.length < 2) return null;
    return (
      <g {...common}>
        <InkPath points={pts} size={PEN_SIZE} filterId={filterId} complete={progress >= 1} />
      </g>
    );
  }
  const a = item.points[0] ? project(item.points[0]) : null;
  const b = item.points[item.points.length - 1] ? project(item.points[item.points.length - 1]!) : null;
  if (!a || !b) return null;
  if (item.kind === "arrow") {
    const strokes = arrowStrokes(a, b, seed);
    // Shaft first, then the head ticks — the order a hand draws it.
    const shaftShare = 0.7;
    return (
      <g {...common}>
        {strokes.map((stroke, i) => {
          const local = i === 0 ? progress / shaftShare : (progress - shaftShare) / (1 - shaftShare);
          const part = partialStroke(stroke, Math.max(0, Math.min(1, local)));
          return part.length >= 2 ? <InkPath key={i} points={part} size={SHAPE_SIZE} filterId={filterId} /> : null;
        })}
      </g>
    );
  }
  const loop = partialStroke(ellipsePoints(a, b, seed), progress);
  if (loop.length < 2) return null;
  return (
    <g {...common}>
      <InkPath points={loop} size={SHAPE_SIZE} filterId={filterId} complete={progress >= 1} />
    </g>
  );
}

function DraftInk({ draft, filterId }: { draft: Draft; filterId: string }) {
  if (draft.kind === "pen") {
    return draft.pts.length >= 2 ? <InkPath points={draft.pts} size={PEN_SIZE} filterId={filterId} complete={false} /> : null;
  }
  if (Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) < 4) return null;
  if (draft.kind === "arrow") {
    return (
      <g>
        {arrowStrokes(draft.from, draft.to, 7).map((s, i) => (
          <InkPath key={i} points={s} size={SHAPE_SIZE} filterId={filterId} />
        ))}
      </g>
    );
  }
  let to = draft.to;
  if (draft.shift) {
    const side = Math.max(Math.abs(to.x - draft.from.x), Math.abs(to.y - draft.from.y));
    to = { x: draft.from.x + Math.sign(to.x - draft.from.x || 1) * side, y: draft.from.y + Math.sign(to.y - draft.from.y || 1) * side };
  }
  return <InkPath points={ellipsePoints(draft.from, to, 7)} size={SHAPE_SIZE} filterId={filterId} />;
}

function TextInk({ item, x, y }: { item: TeacherSketchItem; x: number; y: number }) {
  return (
    <span
      data-testid="teacher-text"
      className="absolute -translate-y-1/2 whitespace-pre font-sans text-sm font-semibold italic tracking-wide text-ink [text-shadow:0_0_3px_rgb(0_0_0),0_1px_2px_rgb(0_0_0)]"
      style={{ left: x, top: y }}
    >
      {item.text}
    </span>
  );
}

function MarkerBadge({ item, x, y }: { item: TeacherSketchItem; x: number; y: number }) {
  return (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center"
      style={{ left: x, top: y }}
      data-testid="teacher-marker"
      data-number={item.number}
      data-label={item.text ?? ""}
    >
      <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs font-bold tabular-nums text-black shadow-[0_0_0_2px_rgb(0_0_0/0.7),0_2px_8px_rgb(0_0_0/0.6)]">
        {item.number ?? "•"}
      </span>
      {item.text ? (
        <span className="absolute left-7 top-1/2 max-w-[14rem] -translate-y-1/2 truncate rounded-md bg-black/80 px-2 py-0.5 text-xs font-medium text-white ring-1 ring-ink/50">
          {item.text}
        </span>
      ) : null}
    </div>
  );
}

function MarkerLabelPopover({
  item,
  frame,
  onSave,
  onCancel,
}: {
  item: TeacherSketchItem;
  frame: SketchFrame;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(item.text ?? "");
  const p = item.points[0] ? frame.project(item.points[0].x_pct, item.points[0].y_pct) : null;
  if (!p) return null;
  const flip = p.x > frame.width - 300;
  return (
    <form
      role="dialog"
      aria-label={`Label marker ${item.number ?? ""}`}
      data-testid="marker-label-popover"
      className={cn(
        "pointer-events-auto absolute z-40 w-64 rounded-lg bg-black/90 p-2.5 text-white shadow-lg ring-1 ring-ink/50 backdrop-blur-md",
        flip ? "-translate-x-[calc(100%+20px)]" : "translate-x-5",
        "-translate-y-1/2"
      )}
      style={{ left: p.x, top: p.y }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <label className="mb-1.5 flex items-center gap-2 text-xs font-medium text-white/80" htmlFor={`marker-label-${item.id}`}>
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ink text-[11px] font-bold tabular-nums text-black">
          {item.number}
        </span>
        Label this finding
      </label>
      <Input
        id={`marker-label-${item.id}`}
        autoFocus
        value={value}
        maxLength={SKETCH_LIMITS.textChars}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        className="h-8 border-white/20 bg-white/[0.06] text-sm text-white placeholder:text-white/50 focus:border-ink focus:bg-white/[0.1]"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="text-white/80 hover:text-white" onClick={onCancel}>
          Keep “{item.text}”
        </Button>
        <Button type="submit" size="sm">
          Save
        </Button>
      </div>
    </form>
  );
}
