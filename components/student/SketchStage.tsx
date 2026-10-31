"use client";

// The tutor's ink on the DICOM viewport.
//
// Strokes are SVG: a hand-drawn centreline (seeded per mark) turned into a
// pressure-tapered outline, drawn in by a moving pen, with a dark halo for
// contrast on bright tissue and a soft glow. Every point is an image
// fraction projected through the live camera each frame, so zoom, pan and
// window never move a mark off its anatomy. Cards are solid, readable HTML,
// seated in the black around the body and tied to the ring by a squiggly
// leader. One confident mark at a time: a stroke that leaves fades out.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  arrowStrokes,
  brushOutline,
  dashStroke,
  drawDurationMs,
  INK,
  inkSeed,
  loopOffsets,
  outlinePath,
  partialStroke,
  penProgress,
  squiggleStroke,
  type Pt,
} from "@/lib/inkStroke";
import {
  cardEdgeToward,
  cardNeedsReseat,
  cardWidthFor,
  placeCardFlexible,
  type Box,
  type LumaGrid,
} from "@/lib/cardPlacement";
import { markVisibleOnSlice, type DiagramTemplate, type SketchMark } from "@/lib/sketchMarks";
import type { SketchFrame } from "@/lib/sketchProjection";
import { cn } from "@/components/ui";

const LEAVE_MS = 280;
const CARD_AFTER_LEADER_MS = 300;

type Clock = { now: number; born: (id: string) => number; reduced: boolean };

export default function SketchStage({
  marks,
  frame,
  sampleImage,
  chromeBoxes,
}: {
  marks: readonly SketchMark[];
  frame: SketchFrame;
  /** Luminance of the rendered image, for seating cards in black space. */
  sampleImage?: () => LumaGrid | null;
  /** Viewer controls a card must not cover. */
  chromeBoxes?: () => Box[];
}) {
  const present = usePresence(marks);
  const clock = useInkClock(present.map((item) => item.mark));
  const narrow = frame.width < 640;
  const visible = present.filter((item) => markVisibleOnSlice(item.mark, frame.sliceIndex));
  const ring = visible.find((item) => item.mark.kind === "circle" || item.mark.kind === "ellipse")?.mark;
  const filterId = useId("ink");

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-testid="sketch-stage"
      data-image-x={ring?.anchor.x_pct}
    >
      <svg
        className="absolute inset-0 h-full w-full overflow-visible"
        width={frame.width}
        height={frame.height}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        aria-hidden="true"
      >
        <defs>
          <filter id={`${filterId}-glow`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={narrow ? 2.6 : 3.4} />
          </filter>
          <filter id={`${filterId}-halo`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={1.4} />
          </filter>
        </defs>
        {visible.map(({ mark, leaving }) => (
          <g
            key={mark.id}
            className="transition-opacity duration-300 ease-out"
            opacity={leaving ? 0 : 1}
          >
            <StrokeMark mark={mark} frame={frame} clock={clock} narrow={narrow} filterId={filterId} />
          </g>
        ))}
      </svg>
      {visible.map(({ mark, leaving }) =>
        mark.kind === "card" && mark.card ? (
          <CardMark
            key={mark.id}
            mark={mark}
            frame={frame}
            clock={clock}
            narrow={narrow}
            leaving={leaving}
            sampleImage={sampleImage}
            chromeBoxes={chromeBoxes}
            filterId={filterId}
          />
        ) : mark.certainty === "uncertain" && mark.kind !== "card" ? (
          <UncertainLabel key={`${mark.id}-label`} mark={mark} frame={frame} leaving={leaving} />
        ) : null
      )}
    </div>
  );
}

// --- clocks and presence ----------------------------------------------------

function useId(prefix: string): string {
  const ref = useRef<string>();
  if (!ref.current) ref.current = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
  return ref.current;
}

/** Keep a removed mark on screen briefly so it can fade instead of blink. */
function usePresence(marks: readonly SketchMark[]): Array<{ mark: SketchMark; leaving: boolean }> {
  const leavingRef = useRef(new Map<string, SketchMark>());
  const lastRef = useRef<readonly SketchMark[]>([]);
  const [, bump] = useState(0);
  const ids = new Set(marks.map((mark) => mark.id));
  for (const mark of lastRef.current) {
    if (!ids.has(mark.id) && !leavingRef.current.has(mark.id)) leavingRef.current.set(mark.id, mark);
  }
  for (const id of ids) leavingRef.current.delete(id);
  lastRef.current = marks;
  const leaving = [...leavingRef.current.values()];
  const leavingKey = leaving.map((mark) => mark.id).join(",");
  useEffect(() => {
    if (!leavingKey) return;
    const timer = window.setTimeout(() => {
      for (const id of leavingKey.split(",")) leavingRef.current.delete(id);
      bump((n) => n + 1);
    }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leavingKey]);
  return [
    ...leaving.map((mark) => ({ mark, leaving: true })),
    ...marks.map((mark) => ({ mark, leaving: false })),
  ];
}

function markEndMs(mark: SketchMark): number {
  if (mark.kind === "card") return mark.delayMs + drawDurationMs("leader") + CARD_AFTER_LEADER_MS + 400;
  return mark.delayMs + mark.durationMs + 60;
}

/** One rAF loop for every stroke in flight. Idle once all ink has landed. */
function useInkClock(marks: readonly SketchMark[]): Clock {
  const births = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => (typeof performance === "undefined" ? 0 : performance.now()));
  const reduced = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    []
  );
  const key = marks.map((mark) => mark.id).join(",");

  useLayoutEffect(() => {
    const t = performance.now();
    let end = 0;
    for (const mark of marks) {
      if (!births.current.has(mark.id)) births.current.set(mark.id, t);
      end = Math.max(end, births.current.get(mark.id)! + markEndMs(mark));
    }
    if (reduced || end <= t) return;
    let raf = 0;
    const tick = () => {
      const at = performance.now();
      setNow(at);
      if (at < end) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `marks` is read through `key`; a new array with the same ids is the same ink.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduced]);

  const born = useCallback((id: string) => births.current.get(id) ?? now, [now]);
  return { now, born, reduced };
}

function elapsed(clock: Clock, mark: SketchMark, extraDelay = 0): number {
  if (clock.reduced) return Number.POSITIVE_INFINITY;
  return clock.now - clock.born(mark.id) - mark.delayMs - extraDelay;
}

// --- geometry ---------------------------------------------------------------

function projectPt(frame: SketchFrame, x: number, y: number): Pt | null {
  const p = frame.project(x, y);
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
}

/** On-screen ring radius for a mark: the anatomy's size, never a speck. */
function ringRadiusPx(frame: SketchFrame, mark: SketchMark, narrow: boolean): { center: Pt; rx: number; ry: number } | null {
  const center = projectPt(frame, mark.anchor.x_pct, mark.anchor.y_pct);
  if (!center) return null;
  const east = projectPt(frame, mark.anchor.x_pct + (mark.rx ?? 0.055), mark.anchor.y_pct);
  const south = projectPt(frame, mark.anchor.x_pct, mark.anchor.y_pct + (mark.ry ?? mark.rx ?? 0.055));
  const min = narrow ? 18 : 22;
  const rx = Math.max(min, east ? Math.abs(east.x - center.x) : min);
  const ryRaw = south ? Math.abs(south.y - center.y) : rx;
  // Keep the anatomy's aspect for an authored ellipse, never thinner than 0.6.
  const ry = Math.max(rx * 0.6, Math.max(min, ryRaw));
  return { center, rx, ry: mark.kind === "ellipse" ? ry : rx };
}

// --- strokes ----------------------------------------------------------------

function Ink({
  centreline,
  size,
  color,
  filterId,
  complete,
  testId,
}: {
  centreline: Pt[];
  size: number;
  color: string;
  filterId: string;
  complete: boolean;
  testId?: string;
}) {
  if (centreline.length < 2) return null;
  const d = outlinePath(brushOutline(centreline, { size, complete }));
  if (!d) return null;
  return (
    <g data-testid={testId}>
      <path d={d} fill="#000" opacity={0.55} filter={`url(#${filterId}-halo)`} transform="translate(0 0.6)" />
      <path d={d} fill={color} opacity={0.42} filter={`url(#${filterId}-glow)`} />
      <path d={d} fill={color} opacity={0.97} />
    </g>
  );
}

function StrokeMark({
  mark,
  frame,
  clock,
  narrow,
  filterId,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  clock: Clock;
  narrow: boolean;
  filterId: string;
}) {
  const seed = useMemo(() => inkSeed(mark.id), [mark.id]);
  const loop = useMemo(() => loopOffsets(seed), [seed]);
  const color = mark.certainty === "uncertain" ? INK.uncertain : INK.authored;
  const size = narrow ? 4.4 : 5.4;
  const uncertain = mark.certainty === "uncertain";
  const t = elapsed(clock, mark);
  if (t < 0) return null;

  if (mark.kind === "circle" || mark.kind === "ellipse") {
    const geo = ringRadiusPx(frame, mark, narrow);
    if (!geo) return null;
    // A loop a little larger than the lesion, so the ink frames it.
    const pad = 1.18;
    const full = loop.map((o) => ({ x: geo.center.x + o.x * geo.rx * pad, y: geo.center.y + o.y * geo.ry * pad }));
    const p = penProgress(t, mark.durationMs);
    const drawn = partialStroke(full, p);
    const parts = uncertain ? dashStroke(drawn, 13, 9) : [drawn];
    return (
      <g data-testid="sketch-ring" data-done={p >= 1 ? "true" : "false"}>
        {parts.map((part, index) => (
          <Ink
            key={index}
            centreline={part}
            size={uncertain ? size * 0.82 : size}
            color={color}
            filterId={filterId}
            complete={p >= 1 || index < parts.length - 1}
          />
        ))}
      </g>
    );
  }

  if (mark.kind === "arrow" && mark.from && mark.to) {
    const from = projectPt(frame, mark.from.x_pct, mark.from.y_pct);
    const tipAt = projectPt(frame, mark.to.x_pct, mark.to.y_pct);
    if (!from || !tipAt) return null;
    let tip = tipAt;
    if (mark.standoff) {
      const edge = projectPt(frame, mark.to.x_pct + mark.standoff, mark.to.y_pct);
      const gap = Math.max(narrow ? 16 : 20, edge ? Math.abs(edge.x - tipAt.x) : 0);
      const len = Math.hypot(tipAt.x - from.x, tipAt.y - from.y) || 1;
      const k = Math.min(0.6, gap / len);
      tip = { x: tipAt.x - (tipAt.x - from.x) * k, y: tipAt.y - (tipAt.y - from.y) * k };
    }
    const strokes = arrowStrokes(from, tip, seed);
    if (!strokes.length) return null;
    // Shaft, lift, then the two head ticks — one hand, three quick strokes.
    const shaftMs = mark.durationMs * 0.62;
    const tickMs = mark.durationMs * 0.19;
    const windows = [
      [0, shaftMs],
      [shaftMs + 40, tickMs],
      [shaftMs + 40 + tickMs + 30, tickMs],
    ] as const;
    return (
      <g data-testid="sketch-arrow">
        {strokes.map((stroke, index) => {
          const [start, ms] = windows[index] ?? windows[0];
          const p = penProgress(t - start, ms);
          if (p <= 0) return null;
          const drawn = partialStroke(stroke, p);
          const parts = uncertain && index === 0 ? dashStroke(drawn, 13, 9) : [drawn];
          return parts.map((part, j) => (
            <Ink
              key={`${index}-${j}`}
              centreline={part}
              size={index === 0 ? size * 0.9 : size * 0.82}
              color={color}
              filterId={filterId}
              complete={p >= 1 || j < parts.length - 1}
            />
          ));
        })}
      </g>
    );
  }
  return null;
}

// --- uncertain label --------------------------------------------------------

function UncertainLabel({ mark, frame, leaving }: { mark: SketchMark; frame: SketchFrame; leaving: boolean }) {
  const narrow = frame.width < 640;
  const geo = ringRadiusPx(frame, mark, narrow);
  if (!geo) return null;
  const left = Math.min(frame.width - 150, geo.center.x + geo.rx * 0.9 + 6);
  const top = Math.max(6, geo.center.y - geo.ry * 1.25 - 18);
  return (
    <p
      data-testid="sketch-uncertain"
      className={cn(
        "absolute whitespace-nowrap rounded-md bg-annotation/90 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-ink-uncertain shadow-annotation transition-opacity duration-300",
        leaving ? "opacity-0" : "opacity-100"
      )}
      style={{ left, top }}
    >
      Uncertain · your tap, not an authored finding
    </p>
  );
}

// --- cards ------------------------------------------------------------------

/**
 * Viewer chrome a card must not cover: the slice / window readout (top left)
 * and the full-screen control (top right).
 */
function viewerChrome(width: number): Box[] {
  return [
    { x: 0, y: 0, width: 120, height: 56 },
    { x: Math.max(0, width - 140), y: 0, width: 140, height: 60 },
  ];
}

const TEMPLATE_LABEL: Record<DiagramTemplate, string> = {
  sign: "Sign",
  differential: "Differential",
  mechanism: "Mechanism",
};

type Seat = { x_pct: number; y_pct: number; width: number; height: number };

function CardMark({
  mark,
  frame,
  clock,
  narrow,
  leaving,
  sampleImage,
  chromeBoxes,
  filterId,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  clock: Clock;
  narrow: boolean;
  leaving: boolean;
  sampleImage?: () => LumaGrid | null;
  chromeBoxes?: () => Box[];
  filterId: string;
}) {
  const card = mark.card!;
  const cardRef = useRef<HTMLDivElement>(null);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [height, setHeight] = useState(0);
  const seed = useMemo(() => inkSeed(`${mark.id}-leader`), [mark.id]);
  const width = cardWidthFor(frame.width);
  const geo = ringRadiusPx(frame, { ...mark, kind: "circle" }, narrow);
  const ringR = geo ? geo.rx * 1.18 : 24;
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const reseat = useCallback(() => {
    const el = cardRef.current;
    const f = frameRef.current;
    const anchor = f.project(mark.anchor.x_pct, mark.anchor.y_pct);
    if (!el || !anchor) return;
    const measured = el.offsetHeight || 120;
    const measuredAt = el.offsetWidth || width;
    const grid = (() => {
      try {
        return sampleImage?.() ?? null;
      } catch {
        return null;
      }
    })();
    const widths = width >= 240 ? [width, 224, 196, 180] : [width];
    const place = placeCardFlexible({
      anchor,
      ringRadius: ringR,
      widths,
      // Body text reflows: area is roughly constant, the header is not.
      heightAt: (w) => Math.round(44 + ((measured - 44) * measuredAt) / w),
      viewport: { width: f.width, height: f.height },
      grid,
      avoid: [...viewerChrome(f.width), ...(chromeBoxes?.() ?? [])],
    });
    const centre = f.unproject(place.x + place.width / 2, place.y + place.height / 2);
    if (centre) setSeat({ x_pct: centre.x_pct, y_pct: centre.y_pct, width: place.width, height: place.height });
  }, [mark.anchor.x_pct, mark.anchor.y_pct, ringR, sampleImage, chromeBoxes, width]);

  // Track the card's real height (fonts, line clamps) so the leader always
  // lands on its edge.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Seat when the leader is about to start, not at mount: by then the
  // viewer has painted this slice, so the black we sample is real.
  const due = elapsed(clock, mark) >= -60;
  useLayoutEffect(() => {
    if (!seat && height > 0 && due) reseat();
  }, [seat, height, due, reseat]);

  // Locked to the anatomy: the seat is an image point. If a zoom or pan
  // pushes the card off the view or onto the ring, reseat after the camera
  // settles (not mid-gesture).
  const centre = seat ? projectPt(frame, seat.x_pct, seat.y_pct) : null;
  const box: Box | null =
    seat && centre
      ? { x: centre.x - seat.width / 2, y: centre.y - (height || seat.height) / 2, width: seat.width, height: height || seat.height }
      : null;
  const stale = Boolean(box && geo && cardNeedsReseat(box, geo.center, ringR, frame));
  const widthChanged = Boolean(seat && seat.width > width);
  useEffect(() => {
    if (!stale && !widthChanged) return;
    const timer = window.setTimeout(reseat, 220);
    return () => window.clearTimeout(timer);
  }, [stale, widthChanged, reseat, frame.width, frame.height]);

  const t = elapsed(clock, mark);
  const leaderMs = drawDurationMs("leader");
  const showLeader = box && geo && t >= 0;
  let leader: ReactNode = null;
  if (showLeader) {
    const edge = cardEdgeToward(box, geo.center);
    const dx = edge.x - geo.center.x;
    const dy = edge.y - geo.center.y;
    const len = Math.hypot(dx, dy) || 1;
    const touch = { x: geo.center.x + (dx / len) * (ringR + 5), y: geo.center.y + (dy / len) * (ringR + 5) };
    const line = squiggleStroke(touch, edge, seed);
    const p = penProgress(t, leaderMs);
    leader = (
      <svg
        className="absolute inset-0 h-full w-full overflow-visible"
        width={frame.width}
        height={frame.height}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        aria-hidden="true"
      >
        <g
          data-testid="sketch-connector"
          className="transition-opacity duration-300"
          opacity={leaving ? 0 : 1}
        >
          <Ink
            centreline={partialStroke(line, p)}
            size={narrow ? 2.4 : 2.8}
            color={mark.certainty === "uncertain" ? INK.uncertain : INK.authored}
            filterId={filterId}
            complete={p >= 1}
          />
        </g>
      </svg>
    );
  }

  // Seating happens as the leader starts, so the card lands as it arrives.
  const appearAt = clock.reduced ? 0 : leaderMs - 40;
  const placed = Boolean(box);
  return (
    <>
      {leader}
      <div
        className={cn(
          "absolute left-0 top-0 transition-opacity duration-300 ease-draw",
          placed ? "" : "invisible",
          leaving ? "opacity-0" : "opacity-100"
        )}
        style={{
          width: seat?.width ?? width,
          transform: box ? `translate3d(${Math.round(box.x)}px, ${Math.round(box.y)}px, 0)` : undefined,
        }}
      >
        <div
          ref={cardRef}
          data-testid="sketch-card"
          data-ink-card
          data-seated={placed ? "true" : "false"}
          className="rounded-xl bg-annotation px-3.5 pb-3 pt-2.5 text-left shadow-annotation"
          style={{
            animation: placed ? `ink-card-in 320ms cubic-bezier(0.22, 1, 0.36, 1) ${appearAt}ms both` : undefined,
          }}
        >
          <p
            className={cn(
              "text-[10px] font-semibold uppercase tracking-[0.14em]",
              mark.certainty === "uncertain" ? "text-ink-uncertain" : "text-ink"
            )}
          >
            {mark.certainty === "uncertain" ? "Uncertain · your tap" : TEMPLATE_LABEL[card.template]}
          </p>
          <p className="mt-1 text-[15px] font-semibold leading-snug tracking-tightest text-white">{card.title}</p>
          <CardBody template={card.template} lines={card.lines} />
        </div>
      </div>
    </>
  );
}

function CardBody({ template, lines }: { template: DiagramTemplate; lines: readonly string[] }) {
  if (!lines.length) return null;
  if (template === "differential") {
    return (
      <ol className="mt-2 space-y-1">
        {lines.map((line, index) => (
          <li key={`${index}-${line}`} className="flex gap-2 text-[13px] leading-snug text-white/80">
            <span className="w-3 shrink-0 text-right tabular-nums text-white/40">{index + 1}</span>
            <span className="line-clamp-2">{line}</span>
          </li>
        ))}
      </ol>
    );
  }
  if (template === "mechanism") {
    return (
      <ol className="mt-2 space-y-1.5 border-l border-white/15 pl-2.5">
        {lines.map((line, index) => (
          <li key={`${index}-${line}`} className="line-clamp-2 text-[13px] leading-snug text-white/80">
            {line}
          </li>
        ))}
      </ol>
    );
  }
  return <p className="mt-1.5 line-clamp-4 text-[13px] leading-[1.45] text-white/80">{lines[0]}</p>;
}
