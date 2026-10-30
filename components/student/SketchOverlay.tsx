"use client";

// Hand-drawn marks over the imaging pane. Positions are projected from
// image fractions every camera frame, so scroll, zoom, pan, and windowing
// leave the stroke on the same anatomy. The layer does not take pointer
// events — stack scroll and the arrow cursor stay with the viewport.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CornerstoneControls } from "@/components/CornerstoneViewer";
import { cardPixelSize, leaderStart, placeCardBox, type SketchFrame } from "@/lib/sketchProjection";
import {
  SKETCH_STROKE,
  markVisibleOnSlice,
  type SketchMark,
} from "@/lib/sketchMarks";
import { drawDurationMs, roughArrowHead, roughPaths, sketchSeed, type RoughKind } from "@/lib/roughStroke";

export function SketchOverlay({
  marks,
  frame: frameProp,
  controls,
  onFrame,
}: {
  marks: readonly SketchMark[];
  /** Fixture and tests pass a camera. The live viewer subscribes instead. */
  frame?: SketchFrame | null;
  controls?: RefObject<CornerstoneControls | null>;
  onFrame?: (frame: SketchFrame | null) => void;
}) {
  const [live, setLive] = useState<SketchFrame | null>(frameProp ?? null);
  const frame = frameProp !== undefined ? frameProp : live;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useLayoutEffect(() => {
    if (frameProp !== undefined) return;
    const ref = controls;
    if (!ref) return;
    let stop = () => {};
    let current: CornerstoneControls | null = null;
    const attach = () => {
      const next = ref.current;
      if (next === current) return;
      stop();
      current = next;
      if (!next?.subscribeView) {
        setLive(null);
        onFrameRef.current?.(null);
        return;
      }
      stop = next.subscribeView((nextFrame) => {
        setLive(nextFrame);
        onFrameRef.current?.(nextFrame);
      });
    };
    attach();
    const timer = window.setInterval(attach, 240);
    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, [controls, frameProp]);

  const [boxes, setBoxes] = useState<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const rememberBox = useCallback((id: string, box: { x: number; y: number; width: number; height: number }) => {
    setBoxes((prev) => {
      const current = prev[id];
      if (current && current.x === box.x && current.y === box.y && current.width === box.width && current.height === box.height) {
        return prev;
      }
      return { ...prev, [id]: box };
    });
  }, []);
  if (!frame || frame.width < 2 || frame.height < 2) return null;
  const visible = marks.filter((mark) => markVisibleOnSlice(mark, frame.sliceIndex));

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="sketch-layer" aria-hidden="true">
      <svg
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        {visible.map((mark) => (
          <SketchStroke key={mark.id} mark={mark} frame={frame} box={boxes[mark.id]} />
        ))}
      </svg>
      {visible
        .filter((mark) => mark.kind === "card" && mark.card)
        .map((mark) => (
          <SketchCard key={`${mark.id}-html`} mark={mark} frame={frame} onBox={rememberBox} />
        ))}
      {visible
        .filter((mark) => mark.caption && mark.kind !== "card")
        .map((mark) => (
          <UncertainTag key={`${mark.id}-tag`} mark={mark} frame={frame} />
        ))}
    </div>
  );
}

function SketchStroke({
  mark,
  frame,
  box,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  box?: { x: number; y: number; width: number; height: number };
}) {
  const seed = sketchSeed(mark.id);
  if (mark.kind === "circle" || mark.kind === "ellipse") return <Ring mark={mark} frame={frame} seed={seed} />;
  if (mark.kind === "arrow" && mark.from && mark.to) return <Arrow mark={mark} frame={frame} seed={seed} />;
  if (mark.kind === "underline" && mark.points && mark.points.length >= 2) {
    return <Underline mark={mark} frame={frame} seed={seed} />;
  }
  if (mark.kind === "card") return <Leader mark={mark} frame={frame} seed={seed} box={box} />;
  return null;
}

function Ring({ mark, frame, seed }: { mark: SketchMark; frame: SketchFrame; seed: number }) {
  const kind: RoughKind = mark.kind === "ellipse" ? "ellipse" : "circle";
  const paths = useMemo(() => roughPaths(kind, seed), [kind, seed]);
  const center = frame.project(mark.anchor.x_pct, mark.anchor.y_pct);
  if (!center) return null;
  const rx = mark.rx ?? 0.055;
  const ry = mark.ry ?? rx;
  const east = frame.project(mark.anchor.x_pct + rx, mark.anchor.y_pct);
  const south = frame.project(mark.anchor.x_pct, mark.anchor.y_pct + ry);
  if (!east || !south) return null;
  const radiusX = Math.max(18, Math.hypot(east.x - center.x, east.y - center.y));
  const radiusY = Math.max(14, Math.hypot(south.x - center.x, south.y - center.y));
  const scaleX = radiusX / 50;
  const scaleY = kind === "ellipse" ? radiusY / 36 : radiusX / 50;
  return (
    <g
      data-testid={`sketch-${kind}`}
      data-image-x={mark.anchor.x_pct}
      data-image-y={mark.anchor.y_pct}
      data-certainty={mark.certainty}
      transform={`translate(${center.x} ${center.y}) scale(${scaleX} ${scaleY})`}
    >
      <DrawPaths paths={paths} stroke={SKETCH_STROKE[mark.color]} delayMs={mark.delayMs} durationMs={mark.durationMs} />
    </g>
  );
}

function Arrow({ mark, frame, seed }: { mark: SketchMark; frame: SketchFrame; seed: number }) {
  const shaftPaths = useMemo(() => roughPaths("arrow", seed), [seed]);
  const headPaths = useMemo(() => roughArrowHead(seed + 3), [seed]);
  const from = mark.from ? frame.project(mark.from.x_pct, mark.from.y_pct) : null;
  const to = mark.to ? frame.project(mark.to.x_pct, mark.to.y_pct) : null;
  if (!from || !to || !mark.to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 8) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const shaft = Math.max(12, length - 18);
  return (
    <g data-testid="sketch-arrow" data-image-x={mark.to!.x_pct} data-image-y={mark.to!.y_pct} data-certainty={mark.certainty}>
      <g transform={`translate(${from.x} ${from.y}) rotate(${angle}) scale(${shaft / 100} 1)`}>
        <DrawPaths paths={shaftPaths} stroke={SKETCH_STROKE[mark.color]} delayMs={mark.delayMs} durationMs={mark.durationMs} />
      </g>
      <g transform={`translate(${to.x} ${to.y}) rotate(${angle})`}>
        <DrawPaths paths={headPaths} stroke={SKETCH_STROKE[mark.color]} delayMs={mark.delayMs + 80} durationMs={Math.min(520, mark.durationMs)} width={2.4} />
      </g>
    </g>
  );
}

function Underline({ mark, frame, seed }: { mark: SketchMark; frame: SketchFrame; seed: number }) {
  const paths = useMemo(() => roughPaths("underline", seed), [seed]);
  const projected = (mark.points ?? []).map((pt) => frame.project(pt.x_pct, pt.y_pct));
  if (projected.some((pt) => !pt)) return null;
  const pts = projected as { x: number; y: number }[];
  const minX = Math.min(...pts.map((pt) => pt.x));
  const minY = Math.min(...pts.map((pt) => pt.y));
  const width = Math.max(36, Math.max(...pts.map((pt) => pt.x)) - minX);
  const height = Math.max(16, Math.max(...pts.map((pt) => pt.y)) - minY);
  return (
    <g
      data-testid="sketch-underline"
      data-image-x={mark.anchor.x_pct}
      data-image-y={mark.anchor.y_pct}
      transform={`translate(${minX} ${minY}) scale(${width / 100} ${height / 24})`}
    >
      <DrawPaths paths={paths} stroke={SKETCH_STROKE[mark.color]} delayMs={mark.delayMs} durationMs={mark.durationMs} width={2.2} />
    </g>
  );
}

function Leader({
  mark,
  frame,
  seed,
  box,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  seed: number;
  box?: { x: number; y: number; width: number; height: number };
}) {
  const paths = useMemo(() => roughPaths("leader", seed), [seed]);
  const anchor = frame.project(mark.anchor.x_pct, mark.anchor.y_pct);
  if (!anchor) return null;
  const estimate = cardPixelSize(frame.width);
  const placed = box ?? {
    ...placeCardBox(anchor, { width: frame.width, height: frame.height }, estimate),
    width: estimate.width,
    height: estimate.height,
  };
  const start = leaderStart(placed, anchor);
  const dx = anchor.x - start.x;
  const dy = anchor.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 6) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <g data-testid="sketch-leader" transform={`translate(${start.x} ${start.y}) rotate(${angle}) scale(${length / 100} 1)`}>
      <DrawPaths paths={paths} stroke={SKETCH_STROKE.yellow} delayMs={mark.delayMs} durationMs={drawDurationMs("leader")} width={2} />
    </g>
  );
}

function DrawPaths({
  paths,
  stroke,
  delayMs,
  durationMs,
  width = 2.7,
}: {
  paths: string[];
  stroke: string;
  delayMs: number;
  durationMs: number;
  width?: number;
}) {
  return (
    <>
      {paths.map((d, index) => (
        <DrawPath key={`${index}-${d.slice(0, 12)}`} d={d} stroke={stroke} delayMs={delayMs} durationMs={durationMs} width={width} />
      ))}
    </>
  );
}

function DrawPath({
  d,
  stroke,
  delayMs,
  durationMs,
  width,
}: {
  d: string;
  stroke: string;
  delayMs: number;
  durationMs: number;
  width: number;
}) {
  const ref = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const len = Math.max(1, el.getTotalLength());
    el.style.strokeDasharray = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    el.style.animation = `sketch-draw-in ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) ${delayMs}ms forwards`;
  }, [d, delayMs, durationMs]);
  return (
    <path
      ref={ref}
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function SketchCard({
  mark,
  frame,
  onBox,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  onBox?: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
}) {
  const card = mark.card;
  const anchor = frame.project(mark.anchor.x_pct, mark.anchor.y_pct);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => cardPixelSize(frame.width));
  const seed = sketchSeed(`${mark.id}-border`);
  const border = useMemo(() => roughPaths("card", seed), [seed]);
  const box = anchor ? placeCardBox(anchor, { width: frame.width, height: frame.height }, size) : null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !box) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    if (width > 8 && height > 8) {
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      onBox?.(mark.id, { x: box.x, y: box.y, width, height });
    }
  }, [mark.id, card?.title, card?.lines.join("|"), frame.width, frame.height, box?.x, box?.y, onBox]);
  if (!card || !anchor || !box) return null;
  return (
    <div
      ref={ref}
      data-testid="sketch-card"
      data-template={card.template}
      className="absolute z-10 w-[min(15.5rem,70vw)]"
      style={{
        left: box.x,
        top: box.y,
        animation: `sketch-card-in ${mark.durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) ${mark.delayMs}ms both`,
      }}
    >
      <div className="relative px-3.5 py-2.5">
        <svg viewBox="0 0 200 90" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <rect width="200" height="90" rx="2" fill="#181818" fillOpacity="0.94" />
          {border.map((d) => (
            <path key={d.slice(0, 18)} d={d} fill="none" stroke={SKETCH_STROKE.yellow} strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <div className="relative font-hand text-[#F6F1E4]">
          {mark.caption ? (
            <p className="text-[13px] uppercase tracking-[0.14em] text-[#FF4DDE]">{mark.caption}</p>
          ) : null}
          <p className="text-[22px] leading-none">{card.title}</p>
          {card.lines.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {card.lines.map((line, index) => (
                <li key={`${index}-${line}`} className="text-[16px] leading-snug text-[#E6DECE]">
                  {card.template === "mechanism" ? `${index + 1}. ${line}` : line}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function UncertainTag({ mark, frame }: { mark: SketchMark; frame: SketchFrame }) {
  const center = frame.project(mark.anchor.x_pct, mark.anchor.y_pct);
  if (!center) return null;
  const left = Math.max(8, Math.min(frame.width - 96, center.x + 14));
  const top = Math.max(8, center.y - 28);
  return (
    <span
      data-testid="sketch-uncertain"
      className="absolute font-hand text-[18px] leading-none text-[#FF4DDE]"
      style={{ left, top }}
    >
      uncertain
    </span>
  );
}
