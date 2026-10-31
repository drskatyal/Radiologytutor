/**
 * Hand-drawn ink for the tutor's marks.
 *
 * A mark is a centreline a person would draw (a loop that overshoots its
 * start, a shaft that bows, a leader that wavers) turned into a filled,
 * pressure-tapered outline with perfect-freehand. Shape noise is seeded by the
 * mark id, so a camera move re-projects the same stroke instead of drawing a
 * new scribble.
 *
 * Shapes are built in unit space (offsets from the anchor, or 0→1 along a
 * segment). The overlay projects the anchor through the live camera each
 * frame and scales the offsets in screen pixels, so the stroke stays on the
 * anatomy while its line weight stays constant.
 */

import { getStroke } from "perfect-freehand";

export interface Pt {
  x: number;
  y: number;
}

/** Ink colours. Authored marks are marker yellow; a learner tap is rose. */
export const INK = {
  authored: "#FFD447",
  uncertain: "#FF8FD8",
} as const;

export type InkTone = keyof typeof INK;

export function inkSeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A loop drawn by hand around a point, in unit offsets (radius ≈ 1).
 *
 * Starts near ten o'clock like a right-handed stroke, runs clockwise on
 * screen, and overshoots the start by ~25° so the ends cross instead of
 * meeting. Radius drifts outward a little over the turn and wobbles at low
 * frequency. It is one stroke.
 */
export function loopOffsets(seed: number, samples = 72): Pt[] {
  const rand = seededRandom(seed);
  const start = -Math.PI * 0.78 + (rand() - 0.5) * 0.5;
  const sweep = Math.PI * 2 + 0.38 + rand() * 0.22;
  const tilt = (rand() - 0.5) * 0.5;
  const squash = 0.9 + rand() * 0.14;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const a1 = 0.035 + rand() * 0.03;
  const a2 = 0.02 + rand() * 0.02;
  const drift = 0.07 + rand() * 0.05;
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const angle = start + sweep * t;
    const r = 1 + a1 * Math.sin(angle * 2 + p1) + a2 * Math.sin(angle * 3 + p2) + drift * (t - 0.5);
    const ex = Math.cos(angle) * r;
    const ey = Math.sin(angle) * r * squash;
    out.push({
      x: ex * Math.cos(tilt) - ey * Math.sin(tilt),
      y: ex * Math.sin(tilt) + ey * Math.cos(tilt),
    });
  }
  return out;
}

/** Quadratic bow from `a` to `b`, `bow` is a fraction of the length. */
function bowed(a: Pt, b: Pt, bow: number, samples: number, wobble: (t: number) => number): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const lift = 4 * t * (1 - t) * bow * len + wobble(t);
    out.push({ x: a.x + dx * t + nx * lift, y: a.y + dy * t + ny * lift });
  }
  return out;
}

/**
 * Arrow in screen pixels: a bowed shaft that stops at the tip, then two
 * short head ticks. Three strokes, drawn in that order.
 */
export function arrowStrokes(from: Pt, to: Pt, seed: number): Pt[][] {
  const rand = seededRandom(seed);
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 6) return [];
  const bow = (rand() > 0.5 ? 1 : -1) * (0.05 + rand() * 0.04);
  const shaft = bowed(from, to, bow, 24, () => 0);
  // Heading at the tip, from the last two shaft samples.
  const tail = shaft[shaft.length - 3] ?? from;
  const heading = Math.atan2(to.y - tail.y, to.x - tail.x);
  const head = Math.min(22, Math.max(12, len * 0.22));
  const spread = 0.48 + rand() * 0.1;
  const tick = (side: number): Pt[] => {
    const angle = heading + Math.PI - side * spread;
    const end = { x: to.x + Math.cos(angle) * head, y: to.y + Math.sin(angle) * head };
    return bowed(end, to, side * 0.06, 6, () => 0);
  };
  return [shaft, tick(1), tick(-1)];
}

/**
 * Leader from a card to the anatomy: a gentle bow with a hand's waver,
 * ending a few pixels short of the ring so it touches, not crosses.
 */
export function squiggleStroke(from: Pt, to: Pt, seed: number): Pt[] {
  const rand = seededRandom(seed);
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 4) return [from, to];
  const waves = Math.max(1.5, Math.min(4.5, len / 46));
  const amp = Math.min(4.2, 1.6 + len / 80);
  const phase = rand() * Math.PI;
  const bow = (rand() > 0.5 ? 1 : -1) * (0.06 + rand() * 0.05);
  return bowed(from, to, bow, Math.max(18, Math.round(len / 5)), (t) => {
    const envelope = Math.sin(Math.PI * t);
    return Math.sin(t * waves * Math.PI * 2 + phase) * amp * envelope;
  });
}

export interface BrushOptions {
  size: number;
  /** Start taper in px. */
  taperStart?: number;
  /** End taper in px. */
  taperEnd?: number;
  thinning?: number;
  /** False while the pen is still moving: the tip stays open, not tapered. */
  complete?: boolean;
}

/**
 * Filled outline for a centreline. Pressure is simulated from the pen's
 * speed, so straights thin and turns thicken a little, the way a marker does.
 */
export function brushOutline(points: readonly Pt[], opts: BrushOptions): Pt[] {
  if (points.length < 2) return [];
  const raw = getStroke(
    points.map((p) => [p.x, p.y]),
    {
      size: opts.size,
      thinning: opts.thinning ?? 0.42,
      smoothing: 0.62,
      streamline: 0.32,
      simulatePressure: true,
      last: opts.complete !== false,
      start: { taper: opts.taperStart ?? opts.size * 2.2, cap: true },
      end: { taper: opts.complete === false ? 0 : (opts.taperEnd ?? opts.size * 3.2), cap: true },
    }
  );
  return raw.map(([x, y]) => ({ x: x!, y: y! }));
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Closed SVG path for a brush outline (quadratic midpoints, smooth). */
export function outlinePath(outline: readonly Pt[]): string {
  const n = outline.length;
  if (n < 3) return "";
  const first = outline[0]!;
  let d = `M${r1(first.x)} ${r1(first.y)} Q`;
  for (let i = 0; i < n; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % n]!;
    d += `${r1(a.x)} ${r1(a.y)} ${r1((a.x + b.x) / 2)} ${r1((a.y + b.y) / 2)} `;
  }
  return `${d}Z`;
}

/** Open SVG polyline for a centreline (used as the draw-in mask). */
export function centrelinePath(points: readonly Pt[]): string {
  if (!points.length) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${r1(p.x)} ${r1(p.y)}`).join(" ");
}

export function polylineLength(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

export type InkKind = "circle" | "ellipse" | "arrow" | "underline" | "leader" | "card";

/**
 * Draw-in time. A confident hand: quick, never instant, never slow.
 * Every mark lands inside 0.4–0.8 s.
 */
export function drawDurationMs(kind: InkKind | "card-in"): number {
  switch (kind) {
    case "circle":
      return 640;
    case "ellipse":
      return 700;
    case "arrow":
      return 520;
    case "underline":
      return 440;
    case "leader":
      return 460;
    case "card":
    case "card-in":
      return 420;
    default:
      return 600;
  }
}

/** One mark at a time: the gap a hand takes between two strokes. */
export const STROKE_GAP_MS = 220;

/** The first `progress` (0–1) of a centreline by arc length. */
export function partialStroke(points: readonly Pt[], progress: number): Pt[] {
  if (progress >= 1 || points.length < 2) return points.slice();
  if (progress <= 0) return [];
  const total = polylineLength(points);
  const target = total * progress;
  const out: Pt[] = [points[0]!];
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (run + seg >= target) {
      const t = seg > 0 ? (target - run) / seg : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      return out;
    }
    run += seg;
    out.push(b);
  }
  return out;
}

/** Split a centreline into dashes (an unconfirmed mark is drawn broken). */
export function dashStroke(points: readonly Pt[], dash: number, gap: number): Pt[][] {
  const out: Pt[][] = [];
  let current: Pt[] = [];
  let run = 0;
  let on = true;
  let budget = dash;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i === 0) {
      current.push(p);
      continue;
    }
    const prev = points[i - 1]!;
    let seg = Math.hypot(p.x - prev.x, p.y - prev.y);
    let from = prev;
    while (seg > 0) {
      const take = Math.min(seg, budget - run);
      const t = take / seg;
      const mid = { x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t };
      if (on) current.push(mid);
      run += take;
      seg -= take;
      from = mid;
      if (run >= budget - 1e-6) {
        if (on && current.length > 1) out.push(current);
        on = !on;
        current = on ? [mid] : [];
        run = 0;
        budget = on ? dash : gap;
      }
    }
  }
  if (on && current.length > 1) out.push(current);
  return out;
}

/** Pen speed over a stroke: brisk, eased at both ends. */
export function penProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  const eased = (1 - Math.cos(Math.PI * t)) / 2;
  return 0.3 * t + 0.7 * eased;
}
