"use client";

// Animated replay overlay — the "wow" layer of record → replay. It sits on a
// NON-INTERACTIVE layer over the viewer (so the viewer keeps mouse control) and
// renders, driven entirely by the replay clock OR by the AI tutor:
//
//   • a LASER POINTER — soft glowing dot tracing the teacher's recorded cursor
//     path (or a synthetic AI approach to a marker), with a fading comet trail.
//   • ANNOTATION DRAW-IN — arrow / circle strokes that draw themselves on.
//
// Positions are normalized [0,1]. Inline styles only for dynamic geometry
// (CLAUDE.md §0).

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { MarkerShape, RecordedEvent } from "@/lib/types";
import { buildPointerPath, playPointerPath } from "@/lib/pointerTween";

/** What the replay engine / tutor calls to drive the overlay. */
export interface ReplayOverlayHandle {
  cursor: (x: number, y: number) => void;
  annotation: (e: Extract<RecordedEvent, { type: "annotation" }>) => void;
  clear: () => void;
  /**
   * Tween the laser from an approach origin to (x,y). Resolves when the tip
   * lands. Cancels any in-flight tween. Used by the AI tutor when a finding
   * has no recorded cursor track.
   */
  animateTo: (
    x: number,
    y: number,
    opts?: { durationMs?: number; from?: { x: number; y: number } }
  ) => Promise<void>;
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
  tool?: string;
  handles?: Array<[number, number]>;
  label?: string;
}

const TRAIL_LENGTH = 8;

/**
 * `accent` is the author tool's laser. `ink` is the student tutor's pen: a
 * white nib with a warm glow, matching the tutor's marks (no blue on the
 * image).
 */
export type ReplayTone = "accent" | "ink";

const TONE = {
  accent: {
    trail: "bg-accent/70",
    halo: "bg-accent/20",
    dot: "border-2 border-accent-foreground/30 bg-accent ring-1 ring-accent/50",
  },
  ink: {
    trail: "bg-ink/60",
    halo: "bg-ink/25 blur-[3px]",
    dot: "bg-white ring-2 ring-ink shadow-[0_0_10px_2px_rgb(255_212_71/0.65),0_0_0_4px_rgb(0_0_0/0.45)]",
  },
} as const;

export const ReplayOverlay = forwardRef<ReplayOverlayHandle, { active: boolean; tone?: ReplayTone }>(
  function ReplayOverlay({ active, tone = "accent" }, ref) {
    const look = TONE[tone];
    const [dot, setDot] = useState<{ x: number; y: number } | null>(null);
    const [trail, setTrail] = useState<TrailPoint[]>([]);
    const [annotations, setAnnotations] = useState<DrawnAnnotation[]>([]);
    const seq = useRef(0);
    const tweenCancel = useRef<(() => void) | null>(null);
    const lastDot = useRef<{ x: number; y: number } | null>(null);

    const paintCursor = (x: number, y: number) => {
      lastDot.current = { x, y };
      setDot({ x, y });
      setTrail((prev) => {
        const next = [...prev, { id: seq.current++, x, y }];
        return next.slice(-TRAIL_LENGTH);
      });
    };

    useImperativeHandle(ref, () => ({
      cursor(x, y) {
        paintCursor(x, y);
      },
      annotation(e) {
        setAnnotations((prev) => [
          ...prev,
          {
            id: seq.current++,
            shape: e.shape,
            from: e.from,
            to: e.to,
            tool: e.tool,
            handles: e.handles,
            label: e.label,
          },
        ]);
      },
      clear() {
        tweenCancel.current?.();
        tweenCancel.current = null;
        setDot(null);
        setTrail([]);
        setAnnotations([]);
        lastDot.current = null;
      },
      async animateTo(x, y, opts) {
        tweenCancel.current?.();
        const path = buildPointerPath(
          { x, y },
          {
            durationMs: opts?.durationMs,
            from: opts?.from ?? lastDot.current ?? undefined,
          }
        );
        const { cancel, done } = playPointerPath(path, paintCursor);
        tweenCancel.current = cancel;
        await done;
        tweenCancel.current = null;
      },
    }));

    if (!active && annotations.length === 0) return null;

    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
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

        {active &&
          trail.map((p, i) => {
          const strength = (i + 1) / trail.length;
          const style: CSSProperties = {
            left: `${p.x * 100}%`,
            top: `${p.y * 100}%`,
            opacity: strength * 0.5,
            transform: `translate(-50%, -50%) scale(${0.4 + strength * 0.6})`,
          };
          return (
            <span
              key={p.id}
              className={`absolute h-2.5 w-2.5 rounded-full ${look.trail}`}
              style={style}
            />
          );
        })}

        {active && dot && (
          <span
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%` }}
          >
            <span className={`absolute -inset-2 rounded-full ${look.halo}`} />
            <span className={`relative block h-3.5 w-3.5 rounded-full ${look.dot}`} />
          </span>
        )}
      </div>
    );
  }
);

function AnnotationStroke({ annotation }: { annotation: DrawnAnnotation }) {
  const [drawn, setDrawn] = useState(false);
  const fromRef = useRef(annotation.from);
  const triggered = useRef(false);
  if (!triggered.current) {
    triggered.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
  }

  const handles = annotation.handles?.length
    ? annotation.handles
    : [fromRef.current, annotation.to];
  const [fx, fy] = fromRef.current.map((v) => v * 100) as [number, number];
  const [tx, ty] = annotation.to.map((v) => v * 100) as [number, number];

  const dashStyle: CSSProperties = {
    strokeDasharray: 1,
    strokeDashoffset: drawn ? 0 : 1,
    transition: "stroke-dashoffset 600ms cubic-bezier(0.16, 1, 0.3, 1)",
  };

  if (annotation.tool === "EllipticalROI" || annotation.tool === "RectangleROI") {
    let minX = 100;
    let minY = 100;
    let maxX = 0;
    let maxY = 0;
    for (const [x, y] of handles) {
      minX = Math.min(minX, x * 100);
      minY = Math.min(minY, y * 100);
      maxX = Math.max(maxX, x * 100);
      maxY = Math.max(maxY, y * 100);
    }
    const rx = Math.max(1, (maxX - minX) / 2);
    const ry = Math.max(1, (maxY - minY) / 2);
    if (annotation.tool === "RectangleROI") {
      return (
        <rect
          x={minX}
          y={minY}
          width={Math.max(1, maxX - minX)}
          height={Math.max(1, maxY - minY)}
          pathLength={1}
          fill="none"
          className="stroke-accent"
          strokeWidth={0.8}
          vectorEffect="non-scaling-stroke"
          style={dashStyle}
        />
      );
    }
    return (
      <ellipse
        cx={(minX + maxX) / 2}
        cy={(minY + maxY) / 2}
        rx={rx}
        ry={ry}
        pathLength={1}
        fill="none"
        className="stroke-accent"
        strokeWidth={0.8}
        vectorEffect="non-scaling-stroke"
        style={dashStyle}
      />
    );
  }

  if (annotation.tool === "Length" || annotation.tool === "Angle" || annotation.tool === "Bidirectional") {
    const pts = handles.map(([x, y]) => [x * 100, y * 100] as [number, number]);
    return (
      <g
        className="stroke-accent"
        strokeWidth={0.8}
        strokeLinecap="round"
        fill="none"
        vectorEffect="non-scaling-stroke"
        style={dashStyle}
      >
        {pts.slice(0, -1).map((a, i) => (
          <line key={i} x1={a[0]} y1={a[1]} x2={pts[i + 1][0]} y2={pts[i + 1][1]} pathLength={1} />
        ))}
      </g>
    );
  }

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
      <line
        x1={tx}
        y1={ty}
        x2={tx + head * Math.cos(a1)}
        y2={ty + head * Math.sin(a1)}
        pathLength={1}
      />
      <line
        x1={tx}
        y1={ty}
        x2={tx + head * Math.cos(a2)}
        y2={ty + head * Math.sin(a2)}
        pathLength={1}
      />
    </g>
  );
}
