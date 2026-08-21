/**
 * Synthetic laser-pointer path for the student tutor.
 *
 * When a finding has no recorded cursor track, the AI still needs to *show*
 * where to look. We tween a pointer from an off-screen start (or a given
 * origin) to the finding's normalized marker in [0,1]. Pure math — the
 * ReplayOverlay paints; this module only generates samples.
 */

export interface Point2 {
  x: number;
  y: number;
}

export interface PointerTweenOptions {
  /** Duration of the approach animation in ms. */
  durationMs?: number;
  /** Sample interval in ms (mirrors ~40ms cursor capture). */
  sampleMs?: number;
  /** Optional start; defaults to a short approach from above-left of the target. */
  from?: Point2;
}

/** Ease-out cubic — fast start, soft land on the finding. */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

/** Default approach origin: slightly above-left of the target, clamped to frame. */
export function defaultApproachFrom(to: Point2): Point2 {
  return {
    x: clamp01(to.x - 0.12),
    y: clamp01(to.y - 0.18),
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Build an ordered list of pointer samples from `from` → `to`.
 * Always includes the exact end point so the laser lands on the marker.
 */
export function buildPointerPath(
  to: Point2,
  opts: PointerTweenOptions = {}
): Point2[] {
  const target: Point2 = {
    x: Number.isFinite(to.x) ? clamp01(to.x) : 0.5,
    y: Number.isFinite(to.y) ? clamp01(to.y) : 0.5,
  };
  const durationMs = Math.max(120, opts.durationMs ?? 900);
  const sampleMs = Math.max(16, opts.sampleMs ?? 40);
  const from = opts.from ?? defaultApproachFrom(target);
  const start: Point2 = {
    x: Number.isFinite(from.x) ? clamp01(from.x) : defaultApproachFrom(target).x,
    y: Number.isFinite(from.y) ? clamp01(from.y) : defaultApproachFrom(target).y,
  };
  const steps = Math.max(1, Math.round(durationMs / sampleMs));
  const path: Point2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = easeOutCubic(i / steps);
    path.push({
      x: start.x + (target.x - start.x) * t,
      y: start.y + (target.y - start.y) * t,
    });
  }
  path[path.length - 1] = { x: target.x, y: target.y };
  return path;
}

/**
 * Play a pointer path through `onCursor`, resolving when the last sample is
 * painted. Returns a cancel function. Uses rAF + wall clock so it stays smooth
 * under load and doesn't depend on audio.
 */
export function playPointerPath(
  path: Point2[],
  onCursor: (x: number, y: number) => void,
  opts: { sampleMs?: number; onEnd?: () => void } = {}
): { cancel: () => void; done: Promise<void> } {
  const sampleMs = Math.max(16, opts.sampleMs ?? 40);
  let cancelled = false;
  let raf = 0;
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  if (path.length === 0) {
    opts.onEnd?.();
    resolve();
    return { cancel: () => undefined, done };
  }

  const started = performance.now();
  const tick = (now: number) => {
    if (cancelled) {
      resolve();
      return;
    }
    // Clamp so a rAF timestamp before `started` never yields a negative index
    // (path[-1] === undefined → crash on p.x).
    const elapsed = Math.max(0, now - started);
    const idx = Math.min(path.length - 1, Math.floor(elapsed / sampleMs));
    const p = path[idx];
    if (!p) {
      opts.onEnd?.();
      resolve();
      return;
    }
    onCursor(p.x, p.y);
    if (idx >= path.length - 1) {
      opts.onEnd?.();
      resolve();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      resolve();
    },
    done,
  };
}
