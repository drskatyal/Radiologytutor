/**
 * Clean a teacher's dense RecordedTrack into an ordered teach script:
 * scroll → window → zoom → point → draw, with narration beats.
 *
 * The dense log stays on the finding for author QA replay and the stats
 * digest. Learners follow this script (lib/replay.ts playTeachingGuide).
 */

import { splitSentences } from "./performancePlan";
import {
  measurementsFromTrack,
  mergeMeasurements,
} from "./findingMeasurements";
import type {
  Finding,
  FindingMeasurement,
  RecordedEvent,
  RecordedTrack,
  TeachBeat,
  TeachViewerAction,
  TeachingGuide,
} from "./types";

/** A slice of structured narration aligned to the track clock. */
export interface NarrationSpan {
  tStartMs: number;
  tEndMs: number;
  text: string;
}

const SLICE_GAP_MS = 350;
const VOI_GAP_MS = 280;
const CAMERA_GAP_MS = 280;
const CURSOR_GAP_MS = 420;
const MERGE_BEAT_MS = 90;
const WW_EPS = 20;
const WC_EPS = 10;
const ZOOM_EPS = 0.06;
const PAN_EPS = 4;
const POINT_EPS = 0.02;

type Pend =
  | { kind: "slice"; t0: number; t: number; index: number; series?: string }
  | { kind: "voi"; t0: number; t: number; ww: number; wc: number }
  | { kind: "camera"; t0: number; t: number; zoom: number; pan: [number, number] }
  | { kind: "cursor"; t0: number; t: number; x: number; y: number };

function pushBeat(beats: TeachBeat[], t: number, action: TeachViewerAction) {
  beats.push({ t, actions: [action] });
}

function annotationAction(
  e: Extract<RecordedEvent, { type: "annotation" }>
): TeachViewerAction {
  const { t: _t, type: _type, ...stroke } = e;
  return { type: "annotate", ...stroke };
}

/**
 * Collapse a dense record into gesture-sized beats. Cursor samples become one
 * point at the end of a dwell. Slice / VOI / zoom runs become the landing value.
 */
export function buildTeachingGuide(
  track: RecordedTrack,
  opts?: { narration?: NarrationSpan[] }
): TeachingGuide {
  const beats: TeachBeat[] = [];
  let pend: Pend | null = null;
  let pendingSeries: string | undefined;
  let knownSlice = track.start.sliceIndex;
  let lastVoi =
    track.start.ww != null &&
    track.start.wc != null &&
    Number.isFinite(track.start.ww) &&
    Number.isFinite(track.start.wc)
      ? { ww: track.start.ww, wc: track.start.wc }
      : undefined;
  let lastCam: { zoom: number; pan: [number, number] } | undefined;
  let lastPt: { x: number; y: number } | undefined;

  const flush = (p: Pend | null) => {
    if (!p) return;
    if (p.kind === "slice") {
      if (p.index === knownSlice && !p.series) return;
      knownSlice = p.index;
      const action: TeachViewerAction = {
        type: "scroll",
        sliceIndex: p.index,
        ...(p.series ? { seriesInstanceUID: p.series } : {}),
      };
      pushBeat(beats, p.t0, action);
      return;
    }
    if (p.kind === "voi") {
      if (
        lastVoi &&
        Math.abs(lastVoi.ww - p.ww) < WW_EPS &&
        Math.abs(lastVoi.wc - p.wc) < WC_EPS
      ) {
        return;
      }
      lastVoi = { ww: p.ww, wc: p.wc };
      pushBeat(beats, p.t0, { type: "window", ww: p.ww, wc: p.wc });
      return;
    }
    if (p.kind === "camera") {
      const panMag = Math.hypot(p.pan[0], p.pan[1]);
      const changed = lastCam
        ? Math.abs(lastCam.zoom - p.zoom) >= ZOOM_EPS ||
          Math.hypot(lastCam.pan[0] - p.pan[0], lastCam.pan[1] - p.pan[1]) >= PAN_EPS
        : Math.abs(p.zoom - 1) >= ZOOM_EPS || panMag >= PAN_EPS;
      if (!changed) return;
      lastCam = { zoom: p.zoom, pan: p.pan };
      pushBeat(beats, p.t0, { type: "zoom", zoom: p.zoom, pan: p.pan });
      return;
    }
    if (
      lastPt &&
      Math.hypot(lastPt.x - p.x, lastPt.y - p.y) < POINT_EPS
    ) {
      return;
    }
    lastPt = { x: p.x, y: p.y };
    pushBeat(beats, p.t, { type: "point", x: p.x, y: p.y });
  };

  for (const e of track.events) {
    if (e.type === "series") {
      flush(pend);
      pend = null;
      pendingSeries = e.seriesInstanceUID;
      continue;
    }
    if (e.type === "annotation") {
      flush(pend);
      pend = null;
      pushBeat(beats, e.t, annotationAction(e));
      continue;
    }
    if (e.type === "invert") {
      flush(pend);
      pend = null;
      pushBeat(beats, e.t, { type: "invert", value: e.value });
      continue;
    }
    if (e.type === "slice") {
      if (pend?.kind === "slice" && e.t - pend.t <= SLICE_GAP_MS) {
        pend.t = e.t;
        pend.index = e.index;
        pend.series = pend.series ?? pendingSeries;
        pendingSeries = undefined;
      } else {
        flush(pend);
        pend = {
          kind: "slice",
          t0: e.t,
          t: e.t,
          index: e.index,
          series: pendingSeries,
        };
        pendingSeries = undefined;
      }
      continue;
    }
    if (e.type === "voi") {
      if (pend?.kind === "voi" && e.t - pend.t <= VOI_GAP_MS) {
        pend.t = e.t;
        pend.ww = e.ww;
        pend.wc = e.wc;
      } else {
        flush(pend);
        pend = { kind: "voi", t0: e.t, t: e.t, ww: e.ww, wc: e.wc };
      }
      continue;
    }
    if (e.type === "camera") {
      if (pend?.kind === "camera" && e.t - pend.t <= CAMERA_GAP_MS) {
        pend.t = e.t;
        pend.zoom = e.zoom;
        pend.pan = e.pan;
      } else {
        flush(pend);
        pend = { kind: "camera", t0: e.t, t: e.t, zoom: e.zoom, pan: e.pan };
      }
      continue;
    }
    if (e.type === "cursor") {
      if (pend?.kind === "cursor" && e.t - pend.t <= CURSOR_GAP_MS) {
        pend.t = e.t;
        pend.x = e.x;
        pend.y = e.y;
      } else {
        flush(pend);
        pend = { kind: "cursor", t0: e.t, t: e.t, x: e.x, y: e.y };
      }
    }
  }
  flush(pend);
  if (pendingSeries) {
    pushBeat(beats, track.durationMs, {
      type: "scroll",
      sliceIndex: knownSlice,
      seriesInstanceUID: pendingSeries,
    });
  }

  const deduped = dedupeAnnotations(beats);
  const merged = mergeCloseBeats(deduped);
  const held = insertHolds(merged);
  const withSay = assignNarration(cueBeats(held), opts?.narration ?? [], track.durationMs);

  return {
    durationMs: track.durationMs,
    start: {
      sliceIndex: track.start.sliceIndex,
      ww: track.start.ww,
      wc: track.start.wc,
    },
    beats: withSay,
  };
}

function dedupeAnnotations(beats: TeachBeat[]): TeachBeat[] {
  const lastAt = new Map<string, { bi: number; ai: number }>();
  beats.forEach((b, bi) => {
    b.actions.forEach((a, ai) => {
      if (a.type === "annotate" && a.annotationUID) {
        lastAt.set(a.annotationUID, { bi, ai });
      }
    });
  });
  return beats
    .map((b, bi) => ({
      ...b,
      actions: b.actions.filter((a, ai) => {
        if (a.type !== "annotate" || !a.annotationUID) return true;
        const last = lastAt.get(a.annotationUID);
        return last?.bi === bi && last.ai === ai;
      }),
    }))
    .filter((b) => b.actions.length > 0);
}

function mergeCloseBeats(beats: TeachBeat[]): TeachBeat[] {
  const out: TeachBeat[] = [];
  for (const b of beats) {
    const last = out[out.length - 1];
    if (last && b.t - last.t <= MERGE_BEAT_MS && b.actions.length > 0) {
      last.actions.push(...b.actions);
    } else {
      out.push({ t: b.t, actions: [...b.actions] });
    }
  }
  return out;
}

/** A consultant does not jump from gesture to gesture. A long quiet gap is a hold. */
const HOLD_GAP_MS = 900;

function insertHolds(beats: TeachBeat[]): TeachBeat[] {
  const out: TeachBeat[] = [];
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    out.push(beat);
    const next = beats[i + 1];
    if (!next) continue;
    const gap = next.t - beat.t;
    if (gap < HOLD_GAP_MS) continue;
    const ms = Math.min(2400, gap - 320);
    if (ms < 450) continue;
    out.push({ t: beat.t + 280, actions: [{ type: "pause", ms }] });
  }
  return out;
}

function spokenWindow(ww: number, wc: number): string {
  const w = Math.round(ww);
  const c = Math.round(wc);
  if (ww >= 1000 && wc <= -400) {
    return `Lung windows, ${w} over ${c}. Air and vessels read here; soft tissue will hide a nodule.`;
  }
  if (ww >= 1400 && wc >= 200) {
    return `Bone windows, ${w} over ${c}. Look at the cortex, not the lung.`;
  }
  if (ww <= 250 && wc >= 20 && wc <= 90) {
    return `Brain windows, ${w} over ${c}. Grey-white contrast lives here.`;
  }
  if (ww >= 300 && ww <= 500 && wc >= 0 && wc <= 80) {
    return `Soft-tissue windows, ${w} over ${c}. Notice what the lung window was hiding.`;
  }
  return `Window ${w} over ${c}. Notice what this setting shows that the last one hid.`;
}

/** Where to go, which window, what to notice, where to look, what to measure. */
function gestureCue(actions: TeachViewerAction[]): string {
  const lines: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case "scroll":
        lines.push(
          a.seriesInstanceUID
            ? `Follow me onto the comparison series, slice ${a.sliceIndex}.`
            : `Follow the stack to slice ${a.sliceIndex}.`
        );
        break;
      case "window":
        lines.push(spokenWindow(a.ww, a.wc));
        break;
      case "zoom":
        if (a.zoom >= 1.2) {
          lines.push(
            `Zoom in, about ${a.zoom.toFixed(1)} times. Stay on this slice and look at the edge.`
          );
        } else if (a.zoom <= 0.85) {
          lines.push(`Zoom back out so you can see where you are.`);
        } else {
          lines.push(`Set the magnification.`);
        }
        break;
      case "point":
        lines.push(`Look here.`);
        break;
      case "annotate": {
        const mm =
          a.lengthMm != null && Number.isFinite(a.lengthMm)
            ? ` It measures ${Math.round(a.lengthMm)} millimetres.`
            : "";
        const lead =
          a.tool === "Length" || a.tool === "Bidirectional"
            ? "Put a caliper on it."
            : a.tool === "EllipticalROI" || a.tool === "RectangleROI"
              ? "Draw a region and read the density."
              : a.tool === "Angle"
                ? "Measure the angle."
                : "Mark it.";
        lines.push(`${lead}${mm}`);
        break;
      }
      case "invert":
        lines.push(a.value ? `Invert the grayscale.` : `Restore the grayscale.`);
        break;
      case "pause":
        lines.push(`Hold. Look before we move.`);
        break;
      default:
        break;
    }
  }
  return lines.join(" ");
}

function cueBeats(beats: TeachBeat[]): TeachBeat[] {
  return beats.map((b) => {
    const cue = gestureCue(b.actions);
    const copy = { ...b, actions: [...b.actions] };
    if (!cue) return copy;
    return { ...copy, say: b.say ? `${cue} ${b.say}` : cue };
  });
}

function joinSay(prev: string | undefined, next: string): string {
  if (!prev) return next;
  return `${prev} ${next}`;
}

function assignNarration(
  beats: TeachBeat[],
  spans: NarrationSpan[],
  durationMs: number
): TeachBeat[] {
  const next = beats.map((b) => ({ ...b, actions: [...b.actions] }));
  for (const span of spans) {
    const sentences = splitSentences(span.text);
    if (!sentences.length) continue;
    const t0 = Math.max(0, span.tStartMs);
    const t1 = Math.max(t0, span.tEndMs);
    let targets = next
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.t >= t0 - 1 && b.t <= t1 + 1)
      .map(({ i }) => i);
    if (!targets.length) targets = next.map((_, i) => i);
    if (!targets.length) {
      sentences.forEach((s, i) => {
        const t = Math.min(durationMs, t0 + i);
        next.push({ t, actions: [], say: s });
      });
      next.sort((a, b) => a.t - b.t);
      continue;
    }
    if (sentences.length === 1) {
      const prefer =
        targets.find((i) =>
          next[i].actions.some((a) => a.type === "point" || a.type === "annotate")
        ) ?? targets[0];
      next[prefer].say = joinSay(next[prefer].say, sentences[0]);
      continue;
    }
    sentences.forEach((s, sIdx) => {
      const slot =
        targets[Math.min(targets.length - 1, Math.floor((sIdx * targets.length) / sentences.length))];
      next[slot].say = joinSay(next[slot].say, s);
    });
  }
  return next;
}

export function narrationText(input: {
  description?: string;
  teachingPoints?: string[];
}): string {
  return [input.description, ...(input.teachingPoints ?? [])]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(". ");
}

/** Guide for one finding track, using its structured text as the spoken beats. */
export function guideForFindingTrack(
  track: RecordedTrack,
  narration: { description?: string; teachingPoints?: string[] }
): TeachingGuide {
  const text = narrationText(narration);
  return buildTeachingGuide(track, {
    narration: text
      ? [{ tStartMs: 0, tEndMs: Math.max(1, track.durationMs), text }]
      : [],
  });
}

/**
 * Prefer a fresh guide from the track + current prose (author edits apply).
 * Fall back to a persisted guide when the dense track was not stored.
 */
export function resolveTeachingGuide(
  finding: Pick<Finding, "track" | "teachingGuide" | "description" | "teachingPoints">
): TeachingGuide | null {
  if (finding.track && (finding.track.events?.length || finding.track.durationMs > 0)) {
    return guideForFindingTrack(finding.track, {
      description: finding.description,
      teachingPoints: finding.teachingPoints,
    });
  }
  if (finding.teachingGuide?.beats?.length) return finding.teachingGuide;
  return null;
}

export function guideHasMotion(guide: TeachingGuide | null | undefined): boolean {
  if (!guide) return false;
  return guide.beats.some((b) => b.actions.length > 0 || Boolean(b.say?.trim()));
}

/** Compact tutor line — the ordered script, not the stats digest. */
export function formatTeachingGuideLine(guide: TeachingGuide | null | undefined): string {
  if (!guide?.beats?.length) return "";
  const bits: string[] = [];
  for (const beat of guide.beats) {
    for (const a of beat.actions) {
      bits.push(formatGuideAction(a));
      if (bits.length >= 14) break;
    }
    if (bits.length >= 14) break;
    if (beat.say?.trim()) {
      const s = beat.say.replace(/\s+/g, " ").trim().slice(0, 72);
      bits.push(`say:"${s}"`);
    }
    if (bits.length >= 14) break;
  }
  if (!bits.length) return "";
  const more = countActions(guide) > bits.filter((b) => !b.startsWith("say:")).length;
  return `guide=[${bits.join(" → ")}${more ? " → …" : ""}]`;
}

function countActions(guide: TeachingGuide): number {
  return guide.beats.reduce((n, b) => n + b.actions.length, 0);
}

function formatGuideAction(a: TeachViewerAction): string {
  switch (a.type) {
    case "scroll":
      return a.seriesInstanceUID
        ? `scroll→${a.sliceIndex}@${a.seriesInstanceUID.slice(-6)}`
        : `scroll→${a.sliceIndex}`;
    case "window":
      return `window(${Math.round(a.ww)}/${Math.round(a.wc)})`;
    case "zoom":
      return `zoom(${a.zoom.toFixed(2)})`;
    case "invert":
      return a.value ? "invert" : "uninvert";
    case "point":
      return `point(${a.x.toFixed(2)},${a.y.toFixed(2)})`;
    case "annotate":
      return `draw(${a.tool || a.shape})`;
    case "pause":
      return `hold(${Math.round(a.ms / 100) / 10}s)`;
    default:
      return "move";
  }
}

/** Strokes on a guide, for the measurement overlay when native placement misses. */
export function measurementsFromGuide(guide: TeachingGuide): FindingMeasurement[] {
  const events: RecordedEvent[] = [];
  for (const beat of guide.beats) {
    for (const a of beat.actions) {
      if (a.type !== "annotate") continue;
      const { type: _type, ...stroke } = a;
      events.push({ t: beat.t, type: "annotation", ...stroke });
    }
  }
  return measurementsFromTrack({
    durationMs: guide.durationMs,
    start: guide.start,
    events,
  });
}

/**
 * Attach the track, its teach script, and any strokes the recording captured
 * onto a finding draft. Live viewport measurements win when both exist.
 */
export function withRecordedTeaching<T extends Partial<Finding>>(
  base: T,
  track: RecordedTrack,
  narration: { description?: string; teachingPoints?: string[] },
  liveMeasurements?: FindingMeasurement[]
): T {
  const teachingGuide = guideForFindingTrack(track, narration);
  const measurements = mergeMeasurements(liveMeasurements, measurementsFromTrack(track));
  return {
    ...base,
    track,
    durationMs: track.durationMs,
    teachingGuide,
    ...(measurements.length ? { measurements } : {}),
  };
}
