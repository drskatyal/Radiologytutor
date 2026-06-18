"use client";

// Animated replay overlay — the "wow" layer of record → replay. It sits on a
// NON-INTERACTIVE layer over the viewer (so the viewer keeps mouse control) and
// renders, driven entirely by the replay clock:
//
//   • a LASER POINTER — a soft glowing dot tracing the teacher's recorded cursor
//     path, with a fading comet trail of recent points.
//   • ANNOTATION DRAW-IN — arrow / circle strokes that draw themselves on with an
//     SVG stroke-dashoffset transition as they're revealed.
//
// Positions are normalized [0,1] (resolution-independent, like Marker). The only
// inline styles are truly-dynamic geometry (left/top %, dash lengths) — allowed
// per CLAUDE.md §0. The replay engine pushes points/annotations through the
// imperative handle; React state drives the paint.

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { MarkerShape, RecordedEvent } from "@/lib/types";

/** What the replay engine calls to drive the overlay. */
export interface ReplayOverlayHandle {
  cursor: (x: number, y: number) => void;
  annotation: (e: Extract<RecordedEvent, { type: "annotation" }>) => void;
  clear: () => void;
}

interface TrailPoint {
  id: number;
  x: number;
  y: number;
}

interface DrawnAnnotation {
  id: number;
  shape: MarkerShape;
  from: [number, number];
  to: [number, number];
}

const TRAIL_LENGTH = 8;

export const ReplayOverlay = forwardRef<ReplayOverlayHandle, { active: boolean }>(
  function ReplayOverlay({ active }, ref) {
    const [dot, setDot] = useState<{ x: number; y: number } | null>(null);
    const [trail, setTrail] = useState<TrailPoint[]>([]);
    const [annotations, setAnnotations] = useState<DrawnAnnotation[]>([]);
    const seq = useRef(0);

    useImperativeHandle(ref, () => ({
      cursor(x, y) {
        setDot({ x, y });
        setTrail((prev) => {
          const next = [...prev, { id: seq.current++, x, y }];
          return next.slice(-TRAIL_LENGTH);
        });
      },
      annotation(e) {
        setAnnotations((prev) => [
          ...prev,
          { id: seq.current++, shape: e.shape, from: e.from, to: e.to },
        ]);
      },
      clear() {
        setDot(null);
        setTrail([]);
        setAnnotations([]);
      },
    }));

    if (!active) return null;

    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {/* Annotation draw-in layer (SVG, normalized 0..100 viewBox). */}
        {annotations.length > 0 && (
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            {annotations.map((a) => (
              <AnnotationStroke key={a.id} annotation={a} />
            ))}
          </svg>
        )}

        {/* Laser pointer comet trail. */}
        {trail.map((p, i) => {
          const strength = (i + 1) / trail.length; // newest = brightest
          const style: CSSProperties = {
            left: `${p.x * 100}%`,
            top: `${p.y * 100}%`,
            opacity: strength * 0.5,
            transform: `translate(-50%, -50%) scale(${0.4 + strength * 0.6})`,
          };
          return (
            <span
              key={p.id}
              className="absolute h-3 w-3 rounded-full bg-accent blur-[2px]"
              style={style}
            />
          );
        })}

        {/* Laser pointer head — soft glowing dot. */}
        {dot && (
          <span
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%` }}
          >
            <span className="absolute -inset-3 rounded-full bg-accent/30 blur-md" />
            <span className="relative block h-3.5 w-3.5 rounded-full bg-accent shadow-[0_0_12px_2px_rgb(var(--accent)/0.8)] ring-2 ring-accent/40" />
          </span>
        )}
      </div>
    );
  }
);

/** One annotation that draws itself in (stroke-dashoffset 1 → 0). */
function AnnotationStroke({ annotation }: { annotation: DrawnAnnotation }) {
  const [drawn, setDrawn] = useState(false);
  const fromRef = useRef(annotation.from);
  // Trigger the draw-in on the next frame after mount.
  const triggered = useRef(false);
  if (!triggered.current) {
    triggered.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
  }

  const [fx, fy] = fromRef.current.map((v) => v * 100) as [number, number];
  const [tx, ty] = annotation.to.map((v) => v * 100) as [number, number];

  // pathLength normalizes the dash math to 1 regardless of true length.
  const dashStyle: CSSProperties = {
    strokeDasharray: 1,
    strokeDashoffset: drawn ? 0 : 1,
    transition: "stroke-dashoffset 600ms cubic-bezier(0.16, 1, 0.3, 1)",
  };

  if (annotation.shape === "circle") {
    const cx = (fx + tx) / 2;
    const cy = (fy + ty) / 2;
    const r = Math.hypot(tx - fx, ty - fy) / 2 || 4;
    return (
      <circle
        cx={cx}
        cy={cy}
        r={r}
        pathLength={1}
        fill="none"
        className="stroke-accent"
        strokeWidth={0.8}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={dashStyle}
      />
    );
  }

  // Arrow: shaft + two head strokes, all drawing in together.
  const angle = Math.atan2(ty - fy, tx - fx);
  const head = 4;
  const a1 = angle + Math.PI - Math.PI / 7;
  const a2 = angle + Math.PI + Math.PI / 7;
  return (
    <g
      className="stroke-accent"
      strokeWidth={0.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      vectorEffect="non-scaling-stroke"
      style={dashStyle}
    >
      <line x1={fx} y1={fy} x2={tx} y2={ty} pathLength={1} />
      <line x1={tx} y1={ty} x2={tx + head * Math.cos(a1)} y2={ty + head * Math.sin(a1)} pathLength={1} />
      <line x1={tx} y1={ty} x2={tx + head * Math.cos(a2)} y2={ty + head * Math.sin(a2)} pathLength={1} />
    </g>
  );
}
