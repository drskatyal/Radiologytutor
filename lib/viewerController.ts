// ============================================================================
// lib/viewerController.ts
//
// The thing that makes playback feel real: instead of jumping straight to the
// target viewport, we animate via rapid URL updates against the Pacsbin iframe.
//
// We only ever SET the iframe src (one-way control). The caller owns the
// iframe element and passes a setter. The controller interpolates slice /
// window / zoom-pan and steps the src each frame.
//
// Transition order: scroll -> window -> zoom/pan -> (caller fades in marker
// + narrates). See runTransition().
//
// PERFORMANCE NOTE (see project README "Pacsbin caching test"): this assumes
// Pacsbin caches the series in-browser so rapid i: updates animate smoothly.
// If a case refetches every slice, lower the fps / raise `sliceStep` to use
// keyframes, or set `mode: "snap"` to skip the scroll animation for that case.
// ============================================================================

import type { Viewport } from "./types";
import { buildViewerUrl, withSlice, withWindow, withZoomPan, type ChromeOptions } from "./pacsbinUrl";

export type ApplyUrl = (url: string) => void;

export interface TransitionOptions {
  /** ~25fps scroll by default. */
  sliceFrameMs?: number;
  /** Animate every Nth slice (1 = every slice). Raise for laggy cases. */
  sliceStep?: number;
  /** Window interpolation: number of frames and per-frame delay. */
  windowFrames?: number;
  windowFrameMs?: number;
  /** Zoom/pan interpolation. */
  zoomFrames?: number;
  zoomFrameMs?: number;
  /** "snap" skips scroll interpolation (fallback for non-caching cases). */
  mode?: "animate" | "snap";
  /** Abort signal — animation stops cleanly when aborted. */
  signal?: AbortSignal;
}

const DEFAULTS: Required<Omit<TransitionOptions, "signal">> = {
  sliceFrameMs: 40,
  sliceStep: 1,
  windowFrames: 20,
  windowFrameMs: 30,
  zoomFrames: 20,
  zoomFrameMs: 30,
  mode: "animate",
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Numeric slice ids let us interpolate. Non-numeric ids fall back to snap. */
function asInt(id: string | undefined): number | null {
  if (!id) return null;
  const digits = id.replace(/[^0-9-]/g, "");
  if (digits === "" || digits === "-") return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/** Rebuild a slice id preserving any non-numeric prefix (e.g. "IMG-42"). */
function withSliceNumber(templateId: string, n: number): string {
  const m = templateId.match(/^(\D*)(-?\d+)(\D*)$/);
  if (!m) return String(n);
  return `${m[1]}${n}${m[3]}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function parseTranslation(t?: string): [number, number] {
  if (!t) return [0, 0];
  const [x, y] = t.split(",").map(Number);
  return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
}

/**
 * Step the slice index from -> to, frame by frame, updating only i:1.
 * `currentUrl` must already encode the target series (we change only slice).
 */
export async function animateScroll(
  currentUrl: string,
  fromSliceId: string,
  toSliceId: string,
  apply: ApplyUrl,
  opts: TransitionOptions = {}
): Promise<string> {
  const o = { ...DEFAULTS, ...opts };
  const from = asInt(fromSliceId);
  const to = asInt(toSliceId);

  // Can't interpolate non-numeric ids — snap to target.
  if (o.mode === "snap" || from === null || to === null || from === to) {
    const url = withSlice(currentUrl, toSliceId);
    apply(url);
    return url;
  }

  const dir = to > from ? 1 : -1;
  let url = currentUrl;
  for (let s = from; dir > 0 ? s <= to : s >= to; s += dir * o.sliceStep) {
    url = withSlice(currentUrl, withSliceNumber(toSliceId, s));
    apply(url);
    await sleep(o.sliceFrameMs, opts.signal);
  }
  // Guarantee we land exactly on target.
  url = withSlice(currentUrl, toSliceId);
  apply(url);
  return url;
}

/** Interpolate ww/wc over windowFrames. */
export async function animateWindow(
  currentUrl: string,
  fromWW: number,
  fromWC: number,
  toWW: number,
  toWC: number,
  apply: ApplyUrl,
  opts: TransitionOptions = {}
): Promise<string> {
  const o = { ...DEFAULTS, ...opts };
  let url = currentUrl;
  if (o.mode === "snap") {
    url = withWindow(currentUrl, toWW, toWC);
    apply(url);
    return url;
  }
  for (let f = 1; f <= o.windowFrames; f++) {
    const t = f / o.windowFrames;
    url = withWindow(currentUrl, Math.round(lerp(fromWW, toWW, t)), Math.round(lerp(fromWC, toWC, t)));
    apply(url);
    await sleep(o.windowFrameMs, opts.signal);
  }
  return url;
}

/** Interpolate scale + translation over zoomFrames. */
export async function animateZoomPan(
  currentUrl: string,
  fromScale: number,
  fromTrans: string,
  toScale: number,
  toTrans: string,
  apply: ApplyUrl,
  opts: TransitionOptions = {}
): Promise<string> {
  const o = { ...DEFAULTS, ...opts };
  const [fx, fy] = parseTranslation(fromTrans);
  const [tx, ty] = parseTranslation(toTrans);
  let url = currentUrl;
  if (o.mode === "snap") {
    url = withZoomPan(currentUrl, toScale, toTrans);
    apply(url);
    return url;
  }
  for (let f = 1; f <= o.zoomFrames; f++) {
    const t = f / o.zoomFrames;
    const scale = +lerp(fromScale, toScale, t).toFixed(4);
    const trans = `${lerp(fx, tx, t).toFixed(1)},${lerp(fy, ty, t).toFixed(1)}`;
    url = withZoomPan(currentUrl, scale, trans);
    apply(url);
    await sleep(o.zoomFrameMs, opts.signal);
  }
  return url;
}

/**
 * Full transition from one viewport to another:
 *   scroll -> window -> zoom/pan.
 * The caller fades in the marker and narrates AFTER this resolves.
 *
 * `from` may be undefined (first finding) — we then snap to the target's
 * series/window/zoom and only animate the slice from the target's own start.
 */
export async function runTransition(
  baseUrl: string,
  from: Viewport | undefined,
  to: Viewport,
  apply: ApplyUrl,
  chrome: ChromeOptions,
  opts: TransitionOptions = {}
): Promise<string> {
  // If switching series (or no prior state), build the full target viewport
  // but start at the FROM slice so the scroll has somewhere to travel.
  const sameSeries = from && from.s1 === to.s1;

  // Establish a base URL locked to the target series with the *starting*
  // window/zoom so window/zoom animate afterwards.
  const startVp: Viewport = {
    ...to,
    i1: sameSeries && from?.i1 ? from.i1 : to.i1,
    ww1: from?.ww1 ?? to.ww1,
    wc1: from?.wc1 ?? to.wc1,
    scale1: from?.scale1 ?? to.scale1,
    translation1: from?.translation1 ?? to.translation1,
  };
  let url = buildViewerUrl(baseUrl, startVp, chrome);
  apply(url);

  // 1. scroll
  if (to.i1) {
    url = await animateScroll(url, startVp.i1, to.i1, apply, opts);
  }
  // 2. window
  if (to.ww1 !== undefined && to.wc1 !== undefined) {
    url = await animateWindow(
      url,
      startVp.ww1 ?? to.ww1,
      startVp.wc1 ?? to.wc1,
      to.ww1,
      to.wc1,
      apply,
      opts
    );
  }
  // 3. zoom/pan
  if (to.scale1 !== undefined) {
    url = await animateZoomPan(
      url,
      startVp.scale1 ?? to.scale1,
      startVp.translation1 ?? "0,0",
      to.scale1,
      to.translation1 ?? "0,0",
      apply,
      opts
    );
  }

  return url;
}
