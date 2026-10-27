/**
 * Helpers for continuous-capture → structured findings.
 * Pure: given a recorded track + session duration, pick the best cursor/slice
 * near a time range so Gemini's segment can land on real pixels.
 */

import type { Marker, RecordedEvent, RecordedTrack } from "./types";

/** Midpoint of [tStart, tEnd], clamped to the track. */
export function segmentMidMs(tStartMs: number, tEndMs: number): number {
  const a = Math.max(0, tStartMs);
  const b = Math.max(a, tEndMs);
  return a + (b - a) / 2;
}

/** Last cursor sample at or before `tMs` (fallback: first cursor in range). */
export function markerNearTime(
  track: RecordedTrack | null | undefined,
  tMs: number
): Marker | null {
  if (!track?.events?.length) return null;
  let best: Extract<RecordedEvent, { type: "cursor" }> | null = null;
  let first: Extract<RecordedEvent, { type: "cursor" }> | null = null;
  for (const e of track.events) {
    if (e.type !== "cursor") continue;
    if (!first) first = e;
    if (e.t <= tMs) best = e;
    else break;
  }
  const hit = best ?? first;
  return hit ? { x_pct: hit.x, y_pct: hit.y, shape: "circle" } : null;
}

/** Last slice index at or before `tMs`. */
export function sliceNearTime(
  track: RecordedTrack | null | undefined,
  tMs: number
): number | null {
  if (!track?.events?.length) return track?.start.sliceIndex ?? null;
  let slice = track.start.sliceIndex;
  for (const e of track.events) {
    if (e.t > tMs) break;
    if (e.type === "slice") slice = e.index;
  }
  return slice;
}

export interface CompareLanding {
  seriesInstanceUID?: string;
  sliceIndex?: number;
  ww?: number;
  wc?: number;
  marker?: { x_pct: number; y_pct: number };
}

/**
 * Compare pane open at `tMs`. Closed, or opened with no slice/series/window/pointer,
 * returns null. Fields come only from the compare event.
 */
export function compareNearTime(
  track: RecordedTrack | null | undefined,
  tMs: number
): CompareLanding | null {
  if (!track?.events?.length) return null;
  let last: Extract<RecordedEvent, { type: "compare" }> | null = null;
  for (const e of track.events) {
    if (e.t > tMs) break;
    if (e.type === "compare") last = e;
  }
  if (!last?.open) return null;
  const landing: CompareLanding = {};
  if (last.seriesInstanceUID?.trim()) landing.seriesInstanceUID = last.seriesInstanceUID.trim();
  if (Number.isFinite(last.sliceIndex)) landing.sliceIndex = last.sliceIndex;
  if (Number.isFinite(last.ww) && Number.isFinite(last.wc)) {
    landing.ww = last.ww;
    landing.wc = last.wc;
  }
  if (Number.isFinite(last.x) && Number.isFinite(last.y)) {
    landing.marker = { x_pct: last.x as number, y_pct: last.y as number };
  }
  if (
    !landing.seriesInstanceUID &&
    landing.sliceIndex == null &&
    landing.ww == null &&
    !landing.marker
  ) {
    return null;
  }
  return landing;
}

/** Last series UID at or before `tMs`. */
export function seriesNearTime(
  track: RecordedTrack | null | undefined,
  tMs: number
): string | null {
  if (!track?.events?.length) return null;
  let uid: string | null = null;
  for (const e of track.events) {
    if (e.t > tMs) break;
    if (e.type === "series") uid = e.seriesInstanceUID;
  }
  return uid;
}

/**
 * Slice a parent track into a child track covering [tStart, tEnd], rebased so
 * events start near t=0. Used when materializing per-finding retraces from a
 * continuous capture session.
 */
export function sliceTrack(
  track: RecordedTrack,
  tStartMs: number,
  tEndMs: number
): RecordedTrack {
  const start = Math.max(0, tStartMs);
  const end = Math.max(start, tEndMs);
  const sliceAtStart = sliceNearTime(track, start) ?? track.start.sliceIndex;
  // Carry WW/WC from the nearest voi before start.
  let ww = track.start.ww;
  let wc = track.start.wc;
  for (const e of track.events) {
    if (e.t > start) break;
    if (e.type === "voi") {
      ww = e.ww;
      wc = e.wc;
    }
  }
  const events = track.events
    .filter((e) => e.t >= start && e.t <= end)
    .map((e) => ({ ...e, t: e.t - start }));
  return {
    durationMs: Math.max(1, end - start),
    start: { sliceIndex: sliceAtStart, ww, wc },
    events,
    audioUrl: track.audioUrl,
  };
}
