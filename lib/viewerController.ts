// ============================================================================
// lib/viewerController.ts
//
// Playback driver for Pacsbin 2.0. We control the viewer by setting its `state`
// query param on the iframe. Changing `state` reloads the cross-origin iframe
// (it's a Vue SPA query param), so we SNAP between recorded keyframes rather
// than scrubbing frame-by-frame. Smooth in-iframe scrubbing isn't possible
// with Pacsbin; that would need a self-hosted Cornerstone3D viewer (the encoded
// fields — seriesId/instanceId/ww/wc/zoom/pan/camera — map 1:1, so a later
// migration is clean).
// ============================================================================

import { buildViewerUrl, type ChromeOptions } from "./pacsbinUrl";
import type { Finding, Keyframe, Marker, PacsbinViewport, ViewerState } from "./types";

export type ApplyUrl = (url: string) => void;

export interface PlayOptions {
  signal?: AbortSignal;
  /** Cap the wait between keyframes so long pauses don't stall playback. */
  maxGapMs?: number;
  /** Called as each keyframe is shown (e.g. to move the marker). */
  onKeyframe?: (index: number) => void;
}

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

/** Snap the viewer to a single encoded state. */
export function showState(
  baseUrl: string,
  state: string,
  apply: ApplyUrl,
  chrome: ChromeOptions
): string {
  const url = buildViewerUrl(baseUrl, state, chrome);
  apply(url);
  return url;
}

/**
 * Replay a recorded flow by snapping to each keyframe's state at its recorded
 * timing (relative to the first keyframe), so narration stays roughly in sync.
 */
export async function playKeyframes(
  baseUrl: string,
  keyframes: Keyframe[],
  apply: ApplyUrl,
  chrome: ChromeOptions,
  opts: PlayOptions = {}
): Promise<void> {
  if (keyframes.length === 0) return;
  const maxGap = opts.maxGapMs ?? 4000;
  let prevT = keyframes[0].t;

  for (let i = 0; i < keyframes.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const kf = keyframes[i];
    if (i > 0) {
      const wait = Math.min(Math.max(0, kf.t - prevT), maxGap);
      if (wait > 0) await sleep(wait, opts.signal);
    }
    apply(buildViewerUrl(baseUrl, kf.state, chrome));
    opts.onKeyframe?.(i);
    prevT = kf.t;
  }
}

// ============================================================================
// SELF-HOSTED CORNERSTONE3D DRIVING MODEL
//
// Now that we render DICOM ourselves (components/CornerstoneViewer), we no
// longer snap a cross-origin iframe — we drive the viewport's camera/VOI/slice
// numerically and interpolate between values with requestAnimationFrame for
// smooth, cinematic step transitions. This is the whole point of self-hosting.
//
// `CornerstoneViewerState` is the viewer-agnostic target a finding resolves to.
// The UI never builds one by hand: it derives it from a finding via
// `findingViewerState`, which reuses the Pacsbin-encoded `state`/keyframes the
// author already captured (fields map 1:1 — see pacsbinUrl.ts) and falls back
// to sane defaults when a finding has no recorded camera.
// ============================================================================

/** A normalized, viewer-agnostic view the Cornerstone viewport can apply. */
export interface CornerstoneViewerState {
  /** Slice to show, as a fraction [0,1] of the stack (resolved to an index by
   *  the viewer, which knows the actual image count). Absent = keep current. */
  sliceFraction?: number;
  /** Window width / center (VOI). Absent = leave VOI untouched. */
  windowWidth?: number;
  windowCenter?: number;
  /** Parallel-scale zoom factor (1 = fit). Absent = reset to fit. */
  zoom?: number;
  /** Pan in viewport CSS pixels [x,y]. Absent = centered. */
  pan?: [number, number];
}

/** A timed keyframe in the Cornerstone driving model (smooth interpolation). */
export interface CornerstoneKeyframe {
  /** ms from the start of the flow. */
  t: number;
  view: CornerstoneViewerState;
  marker?: Marker;
}

/** Pick the primary (first stack) viewport out of a decoded Pacsbin state. */
function primaryViewport(state: ViewerState): PacsbinViewport | undefined {
  return (
    state.viewports?.find((v) => v.type === "stack") ?? state.viewports?.[0]
  );
}

/**
 * Map a decoded Pacsbin viewport onto our Cornerstone driving state. The
 * encoded fields (ww/wc/zoom/pan/instanceId) map 1:1; instanceId can't be
 * turned into a slice fraction without the series, so the caller supplies an
 * optional `sliceFraction` (e.g. derived from finding order) as a hint.
 */
export function viewportToCornerstoneState(
  vp: PacsbinViewport | undefined,
  sliceFraction?: number
): CornerstoneViewerState {
  return {
    sliceFraction,
    windowWidth: vp?.ww,
    windowCenter: vp?.wc,
    zoom: vp?.zoom,
    pan:
      vp?.pan && vp.pan.length >= 2
        ? [vp.pan[0], vp.pan[1]]
        : undefined,
  };
}

/**
 * Decode a finding's recorded Pacsbin `state` into a Cornerstone target view.
 * Returns `null` when there's no decodable state so the caller can fall back to
 * a default (e.g. spread the finding across the stack by its tour order).
 */
export async function findingViewerState(
  finding: Pick<Finding, "state">,
  sliceFraction?: number
): Promise<CornerstoneViewerState | null> {
  if (!finding.state) return null;
  try {
    const { decodeState } = await import("./pacsbinUrl");
    const decoded = await decodeState(finding.state);
    return viewportToCornerstoneState(primaryViewport(decoded), sliceFraction);
  } catch {
    return null;
  }
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ease-in-out cubic — calm, confident motion (no linear/robotic feel). */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * requestAnimationFrame tween from 0→1 over `durationMs`, easing applied,
 * calling `onFrame(eased)` each frame and `onDone()` at the end. Returns a
 * cancel fn. Falls back to an immediate jump when rAF is unavailable (SSR/test)
 * or duration is ~0.
 */
export function tween(
  durationMs: number,
  onFrame: (eased: number) => void,
  onDone?: () => void,
  ease: (t: number) => number = easeInOutCubic
): () => void {
  if (typeof requestAnimationFrame === "undefined" || durationMs <= 0) {
    onFrame(1);
    onDone?.();
    return () => {};
  }
  let raf = 0;
  let cancelled = false;
  const start = performance.now();
  const step = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / durationMs);
    onFrame(ease(t));
    if (t < 1) {
      raf = requestAnimationFrame(step);
    } else {
      onDone?.();
    }
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
  };
}
