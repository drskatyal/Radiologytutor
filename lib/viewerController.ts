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
import type { Keyframe } from "./types";

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
