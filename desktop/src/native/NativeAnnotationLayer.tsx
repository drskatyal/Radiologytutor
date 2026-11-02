// Phase 2, P2.3: measurement and annotation tools on a native viewport.
//
// An SVG layer over the native pixels. Annotations are stored in image pixel
// coordinates (annotations.ts) and mapped to the cell with the transform Rust
// returned for the current view, so they stay on the anatomy through zoom,
// pan, rotate and flip. ROI statistics and the probe value come from Rust
// (decoded modality values). Drawing: press-drag-release for two-point tools
// and freehand; clicks for Angle (3) and Cobb (4); one click for Probe.
// Select by clicking an annotation, drag a handle to edit or the body to move,
// Delete / Backspace removes, Ctrl+Z / Ctrl+Y undo / redo, Escape cancels a
// drawing. Eraser: click to delete. Arrow: type its label after drawing.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "../platform";
import {
  ANNOTATION_TOOLS,
  addAnnotation,
  allAnnotations,
  annotationsFor,
  bidirectionalPoints,
  isDragTool,
  measureText,
  newId,
  pointsNeeded,
  redo,
  removeAnnotations,
  roiShape,
  segmentDistance,
  subscribe,
  undo,
  updateAnnotation,
  type Annotation,
  type Pt,
  type RoiStats,
  type Spacing,
  type ToolName,
} from "./annotations";
import { toCell, toImage, type NativeTransform } from "./transform";

const HIT_PX = 7;
const HANDLE_PX = 5;

interface Props {
  cellKey: string;
  seriesUid: string;
  imageIndex: number;
  transform: NativeTransform;
  spacing: Spacing;
  tool: string;
  active: boolean;
  onDeleted?: (count: number) => void;
}

/** True when this tool is handled by the annotation layer (not navigation). */
export function isAnnotationTool(tool: string): boolean {
  return ANNOTATION_TOOLS.has(tool) || tool === "Eraser";
}

async function statsFor(cellKey: string, a: Annotation): Promise<RoiStats | null> {
  const shape = roiShape(a);
  if (!shape) return null;
  return invoke<RoiStats | null>("native_roi_stats", { id: cellKey, shape }).catch(() => null);
}

export default function NativeAnnotationLayer({ cellKey, seriesUid, imageIndex, transform, spacing, tool, active, onDeleted }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const version = useSyncExternalStore(subscribe, () => allAnnotations().length + ":" + undoMark());
  const list = useMemo(() => annotationsFor(seriesUid, imageIndex), [seriesUid, imageIndex, version]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{ id: string; handle: number | "body"; start: Pt; orig: Pt[] } | null>(null);

  const local = (e: React.PointerEvent | PointerEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const img = (p: Pt): Pt => toImage(transform, p[0], p[1]);
  const cell = (p: Pt): Pt => toCell(transform, p[0], p[1]);

  const refreshStats = useCallback(
    async (a: Annotation) => {
      if (roiShape(a)) updateAnnotation({ ...a, stats: await statsFor(cellKey, a) }, { undoable: false });
    },
    [cellKey]
  );

  // Hit test in screen space.
  const hit = (q: Pt): { a: Annotation; handle: number | "body" } | null => {
    for (const a of [...list].reverse()) {
      const pts = a.points.map(cell);
      const h = pts.findIndex((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= HANDLE_PX + 3);
      if (h >= 0 && a.id === selected) return { a, handle: h };
      for (const [s0, s1] of segments(a)) if (segmentDistance(q, cell(s0), cell(s1)) <= HIT_PX) return { a, handle: "body" };
      if (pts.length === 1 && Math.hypot(pts[0][0] - q[0], pts[0][1] - q[1]) <= HIT_PX) return { a, handle: "body" };
    }
    return null;
  };

  const finish = useCallback(
    async (a: Annotation) => {
      setDraft(null);
      let done = a;
      if (a.tool === "Bidirectional") done = { ...a, points: bidirectionalPoints(a.points[0], a.points[1]) };
      if (a.tool === "Probe") {
        const c = cell(a.points[0]);
        const v = await invoke<{ value: number } | null>("native_pick", { id: cellKey, x: c[0], y: c[1] }).catch(() => null);
        done = { ...done, value: v?.value ?? null };
      }
      addAnnotation(done);
      setSelected(done.id);
      if (done.tool === "ArrowAnnotate") setEditing(done.id);
      await refreshStats(done);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cellKey, refreshStats, transform]
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const q = local(e);
    const h = hit(q);
    if (tool === "Eraser") {
      if (h) onDeleted?.(removeAnnotations([h.a.id]));
      e.stopPropagation();
      return;
    }
    if (draft && !isDragTool(draft.tool)) {
      // Click tools: add the next point.
      const pts = [...draft.points.slice(0, -1), img(q), img(q)];
      const need = pointsNeeded(draft.tool);
      const next = { ...draft, points: pts.slice(0, Math.min(pts.length, need + 1)) };
      if (next.points.length > need) void finish({ ...next, points: next.points.slice(0, need) });
      else setDraft(next);
      e.stopPropagation();
      return;
    }
    if (h) {
      setSelected(h.a.id);
      drag.current = { id: h.a.id, handle: h.handle, start: img(q), orig: h.a.points };
      svgRef.current?.setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }
    setSelected(null);
    const t = tool as ToolName;
    const p = img(q);
    const a: Annotation = { id: newId(), tool: t, seriesUid, imageIndex, points: t === "Probe" ? [p] : [p, p] };
    if (t === "Probe") void finish(a);
    else {
      setDraft(a);
      if (isDragTool(t)) svgRef.current?.setPointerCapture(e.pointerId);
    }
    e.stopPropagation();
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const q = local(e);
    const p = img(q);
    const d = drag.current;
    if (d) {
      const a = list.find((x) => x.id === d.id);
      if (!a) return;
      let pts: Pt[];
      if (d.handle === "body") {
        const dx = p[0] - d.start[0];
        const dy = p[1] - d.start[1];
        pts = d.orig.map(([x, y]) => [x + dx, y + dy] as Pt);
      } else {
        pts = d.orig.map((o, i) => (i === d.handle ? p : o));
      }
      updateAnnotation({ ...a, points: pts }, { undoable: false });
      return;
    }
    if (!draft) return;
    if (draft.tool === "PlanarFreehandROI") {
      const last = cell(draft.points[draft.points.length - 1]);
      if (Math.hypot(last[0] - q[0], last[1] - q[1]) >= 3) setDraft({ ...draft, points: [...draft.points, p] });
    } else {
      setDraft({ ...draft, points: [...draft.points.slice(0, -1), p] });
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d) {
      drag.current = null;
      const a = list.find((x) => x.id === d.id);
      if (a) {
        // One undo step for the whole drag.
        updateAnnotation({ ...a, points: d.orig }, { undoable: false });
        updateAnnotation(a);
        void refreshStats(a);
      }
      return;
    }
    if (!draft || !isDragTool(draft.tool)) return;
    const [a0, a1] = [cell(draft.points[0]), cell(draft.points[draft.points.length - 1])];
    const moved = draft.tool === "PlanarFreehandROI" ? draft.points.length >= 3 : Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) >= 3;
    if (moved) void finish(draft);
    else setDraft(null);
    svgRef.current?.releasePointerCapture?.(e.pointerId);
  };

  // Keyboard on the active viewport: delete, undo / redo, cancel.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape" && draft) {
        setDraft(null);
        e.stopPropagation();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        onDeleted?.(removeAnnotations([selected]));
        setSelected(null);
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (e.shiftKey ? redo() : undo()) e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        if (redo()) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, draft, selected, onDeleted]);

  // ROIs re-measured when the slice changes under them is not needed (per
  // image); but stats computed before the slice was decoded are retried.
  useEffect(() => {
    for (const a of list) if (roiShape(a) && a.stats === undefined) void refreshStats(a);
  }, [list, refreshStats]);

  const capture = isAnnotationTool(tool) || !!draft;
  const shapes = draft ? [...list, draft] : list;
  const editingA = editing ? list.find((a) => a.id === editing) : null;
  return (
    <>
      <svg
        ref={svgRef}
        data-native-annotations
        className={capture ? "absolute inset-0 h-full w-full" : "pointer-events-none absolute inset-0 h-full w-full"}
        onPointerDown={capture ? onPointerDown : undefined}
        onPointerMove={capture ? onPointerMove : undefined}
        onPointerUp={capture ? onPointerUp : undefined}
        onDoubleClick={(e) => {
          const h = hit(local(e as unknown as React.PointerEvent));
          if (h?.a.tool === "ArrowAnnotate") {
            setEditing(h.a.id);
            e.stopPropagation();
          }
        }}
      >
        {shapes.map((a) => (
          <Shape key={a.id} a={a} cell={cell} transform={transform} spacing={spacing} selected={a.id === selected} draft={a === draft} />
        ))}
      </svg>
      {editingA && (
        <LabelEditor
          at={cell(editingA.points[1] ?? editingA.points[0])}
          initial={editingA.label ?? ""}
          onDone={(label) => {
            setEditing(null);
            if (label !== (editingA.label ?? "")) updateAnnotation({ ...editingA, label: label || undefined });
          }}
        />
      )}
    </>
  );
}

// The undo stacks change without the item count changing (update): a cheap
// revision counter for useSyncExternalStore.
let revision = 0;
subscribe(() => {
  revision += 1;
});
function undoMark() {
  return revision;
}

/** Segments used for hit testing, in image coordinates. */
function segments(a: Annotation): [Pt, Pt][] {
  const p = a.points;
  const chain = (q: Pt[]): [Pt, Pt][] => q.slice(1).map((b, i) => [q[i], b]);
  switch (a.tool) {
    case "RectangleROI":
    case "EllipticalROI":
      return chain([p[0], [p[1][0], p[0][1]], p[1], [p[0][0], p[1][1]], p[0]]);
    case "CircleROI": {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      return chain(Array.from({ length: 25 }, (_, i) => [p[0][0] + r * Math.cos((i / 24) * 2 * Math.PI), p[0][1] + r * Math.sin((i / 24) * 2 * Math.PI)] as Pt));
    }
    case "PlanarFreehandROI":
      return chain([...p, p[0]]);
    case "CobbAngle":
    case "Bidirectional":
      return p.length >= 4 ? [[p[0], p[1]], [p[2], p[3]]] : chain(p);
    default:
      return chain(p);
  }
}

function Shape({
  a,
  cell,
  transform,
  spacing,
  selected,
  draft,
}: {
  a: Annotation;
  cell: (p: Pt) => Pt;
  transform: NativeTransform;
  spacing: Spacing;
  selected: boolean;
  draft: boolean;
}) {
  const p = a.points.map(cell);
  const stroke = selected ? "rgb(var(--accent))" : "rgb(250 204 21)";
  const common = { stroke, strokeWidth: 1.5, fill: "none", vectorEffect: "non-scaling-stroke" as const };
  const label = measureText(a, spacing);
  const anchor = p[p.length - 1] ?? [0, 0];
  let body: React.ReactNode = null;
  switch (a.tool) {
    case "Length":
    case "Angle":
      body = <polyline points={p.map((q) => q.join(",")).join(" ")} {...common} />;
      break;
    case "CobbAngle":
      body = (
        <>
          <line x1={p[0][0]} y1={p[0][1]} x2={p[1]?.[0]} y2={p[1]?.[1]} {...common} />
          {p.length >= 4 && <line x1={p[2][0]} y1={p[2][1]} x2={p[3][0]} y2={p[3][1]} {...common} />}
        </>
      );
      break;
    case "Bidirectional": {
      const q = a.points.length >= 4 ? p : bidirectionalPoints(a.points[0], a.points[1]).map(cell);
      body = (
        <>
          <line x1={q[0][0]} y1={q[0][1]} x2={q[1][0]} y2={q[1][1]} {...common} />
          <line x1={q[2][0]} y1={q[2][1]} x2={q[3][0]} y2={q[3][1]} {...common} />
        </>
      );
      break;
    }
    case "RectangleROI":
      body = <polygon points={[a.points[0], [a.points[1][0], a.points[0][1]] as Pt, a.points[1], [a.points[0][0], a.points[1][1]] as Pt].map(cell).map((q) => q.join(",")).join(" ")} {...common} />;
      break;
    case "EllipticalROI": {
      const c = cell([(a.points[0][0] + a.points[1][0]) / 2, (a.points[0][1] + a.points[1][1]) / 2]);
      const turned = transform.sin !== 0;
      const rx = (Math.abs(a.points[1][0] - a.points[0][0]) / 2) * transform.scale;
      const ry = (Math.abs(a.points[1][1] - a.points[0][1]) / 2) * transform.scale;
      body = <ellipse cx={c[0]} cy={c[1]} rx={turned ? ry : rx} ry={turned ? rx : ry} {...common} />;
      break;
    }
    case "CircleROI": {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      body = <circle cx={p[0][0]} cy={p[0][1]} r={r} {...common} />;
      break;
    }
    case "PlanarFreehandROI":
      body = <polygon points={p.map((q) => q.join(",")).join(" ")} {...common} />;
      break;
    case "Probe":
      body = <circle cx={p[0][0]} cy={p[0][1]} r={3} fill={stroke} />;
      break;
    case "ArrowAnnotate": {
      // Arrow head at the first point.
      const [h, t] = [p[0], p[1]];
      const ang = Math.atan2(h[1] - t[1], h[0] - t[0]);
      const w = 9;
      const l: Pt = [h[0] - w * Math.cos(ang - 0.45), h[1] - w * Math.sin(ang - 0.45)];
      const r: Pt = [h[0] - w * Math.cos(ang + 0.45), h[1] - w * Math.sin(ang + 0.45)];
      body = (
        <>
          <line x1={t[0]} y1={t[1]} x2={h[0]} y2={h[1]} {...common} />
          <polygon points={[h, l, r].map((q) => q.join(",")).join(" ")} fill={stroke} stroke={stroke} />
        </>
      );
      break;
    }
  }
  return (
    <g data-annotation={a.tool} data-annotation-id={a.id}>
      {body}
      {label && (
        <text
          x={anchor[0] + 8}
          y={anchor[1] - 8}
          className="fill-white text-[11px] tabular-nums [paint-order:stroke] [stroke-width:3px] [stroke:rgb(0_0_0/0.85)]"
        >
          {label}
        </text>
      )}
      {selected && p.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r={HANDLE_PX} fill="rgb(var(--accent))" stroke="white" strokeWidth={1} />)}
    </g>
  );
}

function LabelEditor({ at, initial, onDone }: { at: Pt; initial: string; onDone: (label: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      aria-label="Arrow label"
      value={value}
      placeholder="Label (optional)"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value.trim());
        if (e.key === "Escape") onDone(initial);
      }}
      onBlur={() => onDone(value.trim())}
      className="absolute z-40 w-44 rounded-md border border-strong bg-elevated px-2 py-1 text-xs text-primary shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
      // Dynamic position next to the arrow's tail.
      style={{ left: at[0] + 8, top: at[1] + 8 }}
    />
  );
}
