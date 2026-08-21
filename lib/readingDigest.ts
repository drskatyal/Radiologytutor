/**
 * Compress a teacher's RecordedTrack into a short reading-pattern digest.
 *
 * Tracks are NOT student-facing tape. They arm the tutor with how THIS
 * radiologist scrolled, windowed, zoomed, and pointed — so the AI can teach
 * in that craft. See docs/CONSULTANT_READING.md.
 */

import type { Finding, RecordedEvent, RecordedTrack } from "./types";

export type ReadingDigest = {
  durationMs: number;
  startSlice: number;
  sliceMin?: number;
  sliceMax?: number;
  sliceSteps: number;
  startWw?: number;
  startWc?: number;
  endWw?: number;
  endWc?: number;
  zoomMin?: number;
  zoomMax?: number;
  seriesSwitches: number;
  cursorSamples: number;
  annotationStrokes: number;
};

/** Build a compact digest from a dense record log (O(events)). */
export function digestReadingTrack(track: RecordedTrack): ReadingDigest {
  let sliceMin: number | undefined;
  let sliceMax: number | undefined;
  let sliceSteps = 0;
  let endWw = track.start.ww;
  let endWc = track.start.wc;
  let zoomMin: number | undefined;
  let zoomMax: number | undefined;
  let seriesSwitches = 0;
  let cursorSamples = 0;
  let annotationStrokes = 0;

  for (const e of track.events) {
    switch (e.type) {
      case "slice":
        sliceSteps += 1;
        sliceMin =
          sliceMin == null ? e.index : Math.min(sliceMin, e.index);
        sliceMax =
          sliceMax == null ? e.index : Math.max(sliceMax, e.index);
        break;
      case "voi":
        endWw = e.ww;
        endWc = e.wc;
        break;
      case "camera":
        zoomMin =
          zoomMin == null ? e.zoom : Math.min(zoomMin, e.zoom);
        zoomMax =
          zoomMax == null ? e.zoom : Math.max(zoomMax, e.zoom);
        break;
      case "series":
        seriesSwitches += 1;
        break;
      case "cursor":
        cursorSamples += 1;
        break;
      case "annotation":
        annotationStrokes += 1;
        break;
      default:
        break;
    }
  }

  return {
    durationMs: track.durationMs,
    startSlice: track.start.sliceIndex,
    sliceMin,
    sliceMax,
    sliceSteps,
    startWw: track.start.ww,
    startWc: track.start.wc,
    endWw,
    endWc,
    zoomMin,
    zoomMax,
    seriesSwitches,
    cursorSamples,
    annotationStrokes,
  };
}

/** One-line tutor context: how the consultant read this finding. */
export function formatReadingDigestLine(d: ReadingDigest): string {
  const bits: string[] = [`read=${Math.round(d.durationMs / 1000)}s`];
  if (d.sliceSteps > 0 && d.sliceMin != null && d.sliceMax != null) {
    bits.push(
      d.sliceMin === d.sliceMax
        ? `scroll(slice=${d.sliceMin},steps=${d.sliceSteps})`
        : `scroll(slices=${d.sliceMin}..${d.sliceMax},steps=${d.sliceSteps})`
    );
  } else {
    bits.push(`land(slice=${d.startSlice})`);
  }
  if (
    d.startWw != null &&
    d.startWc != null &&
    Number.isFinite(d.startWw) &&
    Number.isFinite(d.startWc)
  ) {
    const same =
      d.endWw === d.startWw && d.endWc === d.startWc;
    bits.push(
      same
        ? `windowed(ww=${Math.round(d.startWw)},wc=${Math.round(d.startWc)})`
        : `windowed(start=${Math.round(d.startWw)}/${Math.round(d.startWc)}→end=${Math.round(d.endWw ?? d.startWw)}/${Math.round(d.endWc ?? d.startWc)})`
    );
  }
  if (d.zoomMin != null && d.zoomMax != null) {
    bits.push(
      Math.abs(d.zoomMax - d.zoomMin) < 0.05
        ? `zoom≈${d.zoomMin.toFixed(2)}`
        : `zoom=${d.zoomMin.toFixed(2)}..${d.zoomMax.toFixed(2)}`
    );
  }
  if (d.seriesSwitches > 0) bits.push(`seriesSwitches=${d.seriesSwitches}`);
  if (d.cursorSamples > 0) bits.push(`pointed`);
  if (d.annotationStrokes > 0) bits.push(`drew=${d.annotationStrokes}`);
  return bits.join(" · ");
}

export function formatFindingReadingContext(f: Finding): string | null {
  const track = f.track;
  if (!track?.events?.length) return null;
  return formatReadingDigestLine(digestReadingTrack(track));
}

/** Sample a few keyframes (start / mid / end) for richer tool hints — not a tape. */
export function sampleTrackLandings(
  events: RecordedEvent[],
  max = 3
): Array<{ t: number; type: string; detail: string }> {
  if (events.length === 0) return [];
  const picks = new Set<number>();
  picks.add(0);
  if (events.length > 1) picks.add(events.length - 1);
  if (events.length > 2) picks.add(Math.floor(events.length / 2));
  const out: Array<{ t: number; type: string; detail: string }> = [];
  for (const i of [...picks].sort((a, b) => a - b)) {
    if (out.length >= max) break;
    const e = events[i];
    let detail = "";
    if (e.type === "slice") detail = `i=${e.index}`;
    else if (e.type === "voi") detail = `ww=${Math.round(e.ww)},wc=${Math.round(e.wc)}`;
    else if (e.type === "camera") detail = `z=${e.zoom.toFixed(2)}`;
    else if (e.type === "cursor") detail = `@(${e.x.toFixed(2)},${e.y.toFixed(2)})`;
    else if (e.type === "series") detail = e.seriesInstanceUID.slice(-8);
    else detail = e.type;
    out.push({ t: e.t, type: e.type, detail });
  }
  return out;
}
