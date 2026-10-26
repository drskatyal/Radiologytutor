/**
 * Clean a teacher's dense RecordedTrack into an attending script:
 * orient → search → lean-in → commit → pearl.
 *
 * Sparse anchors are the truth (the committed slice, window, zoom, point,
 * and the final stroke). The dense log only times those acts. Intermediate
 * scrolls, window fumbles, and zoom-in-then-out are not replayed.
 *
 * Learners follow this script (lib/replay.ts playTeachingGuide) and hear
 * each act via TTS. They do not hear the microphone tape.
 */

import { splitSentences } from "./performancePlan";
import {
  measurementsFromTrack,
  mergeMeasurements,
} from "./findingMeasurements";
import type {
  Finding,
  FindingMeasurement,
  NarrationSpan,
  RecordedEvent,
  RecordedTrack,
  TeachAct,
  TeachBeat,
  TeachViewerAction,
  TeachingGuide,
} from "./types";

export type { NarrationSpan };

const WW_EPS = 20;
const WC_EPS = 10;
const ZOOM_EPS = 0.12;
const PAN_EPS = 4;
const POINT_EPS = 0.06;

/** Authored landing. Omitted fields fall back to the track's settled end state. */
export interface SparseAnchors {
  sliceIndex?: number;
  ww?: number;
  wc?: number;
  zoom?: number;
  pan?: [number, number];
  point?: { x: number; y: number };
  label?: string;
  description?: string;
  teachingPoints?: string[];
}

const CONTENT_STOP = new Set([
  "right",
  "left",
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "only",
  "into",
  "your",
  "they",
  "them",
  "then",
  "than",
  "when",
  "what",
  "here",
  "look",
  "slice",
  "window",
  "windows",
  "lung",
  "soft",
  "tissue",
  "about",
  "there",
  "their",
  "which",
  "where",
  "would",
  "could",
  "should",
  "stack",
  "follow",
  "small",
  "large",
  "upper",
  "lower",
  "solid",
  "apical",
]);

function wordWeight(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, words.length);
}

function sentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !CONTENT_STOP.has(w));
}

/** True when the sentence uses a word that also lives in the finding text. */
function overlapsFinding(line: string, corpus: string): boolean {
  const words = contentWords(line);
  if (!words.length) return false;
  const hay = corpus.toLowerCase();
  return words.some((w) => hay.includes(w));
}

function mostlyCovered(line: string, corpus: string): boolean {
  const words = contentWords(line);
  if (!words.length) {
    const needle = line.toLowerCase().replace(/\s+/g, " ").trim();
    return needle.length > 0 && corpus.toLowerCase().includes(needle.slice(0, 48));
  }
  const hay = corpus.toLowerCase();
  const hit = words.filter((w) => hay.includes(w)).length;
  return hit / words.length >= 0.6;
}

/**
 * Split a verbatim transcript across the take by word count.
 * Assumes a roughly constant speaking rate. This is not forced alignment:
 * pauses, false starts, and "um"s are not detected. Prefer model-estimated
 * segment times when `coerceNarrationSpans` accepts them.
 */
export function spansFromTranscript(text: string, durationMs: number): NarrationSpan[] {
  const sentences = splitSentences(text);
  const duration = Math.max(0, durationMs);
  if (!sentences.length || duration <= 0) return [];
  const weights = sentences.map(wordWeight);
  const total = weights.reduce((sum, w) => sum + w, 0) || sentences.length;
  let cursor = 0;
  return sentences.map((line, i) => {
    const share = (weights[i] || 1) / total;
    const tStartMs = Math.round(cursor);
    cursor += share * duration;
    const tEndMs = i === sentences.length - 1 ? duration : Math.max(tStartMs + 1, Math.round(cursor));
    return { tStartMs, tEndMs: Math.max(tStartMs + 1, tEndMs), text: line };
  });
}

/** Clamp, drop empties, and order spans on the track clock. */
export function normalizeNarrationSpans(
  raw: Array<Partial<NarrationSpan>> | undefined,
  durationMs: number
): NarrationSpan[] {
  const duration = Math.max(1, durationMs);
  const spans: NarrationSpan[] = [];
  for (const item of raw ?? []) {
    const text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    let tStartMs = Number(item.tStartMs);
    let tEndMs = Number(item.tEndMs);
    if (!Number.isFinite(tStartMs)) tStartMs = 0;
    if (!Number.isFinite(tEndMs)) tEndMs = tStartMs + 1;
    tStartMs = Math.max(0, Math.min(duration, tStartMs));
    tEndMs = Math.max(tStartMs + 1, Math.min(duration, tEndMs));
    spans.push({ tStartMs, tEndMs, text });
  }
  spans.sort((a, b) => a.tStartMs - b.tStartMs || a.tEndMs - b.tEndMs);
  return spans;
}

function estimatedSpansUsable(
  raw: Array<Partial<NarrationSpan>> | undefined,
  durationMs: number,
  sentenceCount: number
): boolean {
  if (!raw?.length || durationMs <= 0) return false;
  const rows = raw.filter((item) => typeof item.text === "string" && item.text.trim());
  if (!rows.length) return false;
  // One span covering the whole take is the naive blob, not alignment.
  if (rows.length === 1 && sentenceCount > 1) {
    const start = Number(rows[0].tStartMs);
    const end = Number(rows[0].tEndMs);
    if (Number.isFinite(start) && Number.isFinite(end) && end - start >= durationMs * 0.85) {
      return false;
    }
  }
  let prev = -1;
  for (const item of rows) {
    const start = Number(item.tStartMs);
    const end = Number(item.tEndMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
    if (start < -50 || end > durationMs + 250) return false;
    if (start + 30 < prev) return false;
    prev = start;
  }
  return true;
}

export type NarrationAlignment = "estimated" | "proportional";

/**
 * Keep model segment times when they are ordered and inside the take.
 * Otherwise split the verbatim transcript by word count and say so.
 */
export function coerceNarrationSpans(
  segments: Array<Partial<NarrationSpan>> | undefined,
  transcript: string,
  durationMs: number
): { spans: NarrationSpan[]; alignment: NarrationAlignment } {
  const duration = Math.max(0, durationMs);
  const sentences = splitSentences(transcript);
  if (estimatedSpansUsable(segments, duration, sentences.length)) {
    return {
      spans: normalizeNarrationSpans(segments, Math.max(1, duration)),
      alignment: "estimated",
    };
  }
  const blob = (segments ?? [])
    .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
    .filter(Boolean)
    .join(" ");
  const text = transcript.trim() || blob;
  return {
    spans: spansFromTranscript(text, Math.max(duration, 1)),
    alignment: "proportional",
  };
}

/**
 * Body of POST /api/transcribe-narration, before Gemini. Same checks the
 * route returns as 400. A fixture WAV uses this so CI does not need a mic.
 */
export function narrationRequestFromBody(
  body: unknown
):
  | { ok: true; audioBase64: string; mime: string; durationMs: number }
  | { ok: false; error: string } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const audio =
    record.audio && typeof record.audio === "object"
      ? (record.audio as Record<string, unknown>)
      : {};
  const audioBase64 = typeof audio.base64 === "string" ? audio.base64.trim() : "";
  const mime = typeof audio.mime === "string" && audio.mime.trim() ? audio.mime : "audio/webm";
  const durationMs = Number(record.durationMs);
  if (!audioBase64) return { ok: false, error: "audio.base64 is required" };
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, error: "durationMs is required" };
  }
  return { ok: true, audioBase64, mime, durationMs };
}

/**
 * What /api/transcribe-narration returns after STT. Segment times are kept
 * when they are ordered and inside the take; otherwise the verbatim
 * transcript is split by word count.
 */
export function publishNarrationTake(
  taken: { transcript?: string; segments?: Array<Partial<NarrationSpan>> },
  durationMs: number
): { transcript: string; spans: NarrationSpan[]; alignment: NarrationAlignment } {
  const transcript = typeof taken.transcript === "string" ? taken.transcript.trim() : "";
  const aligned = coerceNarrationSpans(taken.segments, transcript, durationMs);
  return { transcript, spans: aligned.spans, alignment: aligned.alignment };
}

interface Money {
  sliceIndex: number;
  ww?: number;
  wc?: number;
  zoom?: { zoom: number; pan: [number, number] };
  point?: { x: number; y: number };
  series?: string;
  annotation?: Extract<RecordedEvent, { type: "annotation" }>;
  invert?: boolean;
}

function lastOf<T extends RecordedEvent["type"]>(
  track: RecordedTrack,
  type: T
): Extract<RecordedEvent, { type: T }> | undefined {
  for (let i = track.events.length - 1; i >= 0; i--) {
    const event = track.events[i];
    if (event.type === type) return event as Extract<RecordedEvent, { type: T }>;
  }
  return undefined;
}

function voiClose(
  ww: number,
  wc: number,
  targetWw: number,
  targetWc: number
): boolean {
  return Math.abs(ww - targetWw) < WW_EPS && Math.abs(wc - targetWc) < WC_EPS;
}

/** Committed landing from the end of the log. Fumbles in the middle are ignored. */
export function settledDisplay(track: RecordedTrack): {
  sliceIndex: number;
  ww?: number;
  wc?: number;
} {
  const money = moneyFromTrack(track);
  return { sliceIndex: money.sliceIndex, ww: money.ww, wc: money.wc };
}

function moneyFromTrack(track: RecordedTrack): Money {
  const lastSlice = lastOf(track, "slice");
  const lastAnn = lastOf(track, "annotation");
  const lastVoi = lastOf(track, "voi");
  const lastCam = lastOf(track, "camera");
  const lastCursor = lastOf(track, "cursor");
  const lastSeries = lastOf(track, "series");
  const lastInvert = lastOf(track, "invert");
  const sliceIndex =
    lastAnn?.sliceIndex != null && Number.isFinite(lastAnn.sliceIndex)
      ? lastAnn.sliceIndex
      : (lastSlice?.index ?? track.start.sliceIndex);
  let zoom: Money["zoom"];
  if (lastCam) {
    const panMag = Math.hypot(lastCam.pan[0], lastCam.pan[1]);
    if (Math.abs(lastCam.zoom - 1) >= ZOOM_EPS || panMag >= PAN_EPS) {
      zoom = { zoom: lastCam.zoom, pan: lastCam.pan };
    }
  }
  return {
    sliceIndex,
    ww: lastVoi?.ww ?? track.start.ww,
    wc: lastVoi?.wc ?? track.start.wc,
    zoom,
    point: lastCursor ? { x: lastCursor.x, y: lastCursor.y } : undefined,
    series: lastSeries?.seriesInstanceUID,
    annotation: lastAnn,
    invert: lastInvert?.value === true ? true : undefined,
  };
}

/**
 * Finding fields win when they are a real landing. A slice/window that merely
 * copies the track's opening frame is the prime, not the commit — the log's
 * settled end is the money shot.
 */
function resolveMoney(track: RecordedTrack, anchors?: SparseAnchors): Money {
  const settled = moneyFromTrack(track);
  const slice =
    anchors?.sliceIndex != null && Number.isFinite(anchors.sliceIndex)
      ? anchors.sliceIndex === track.start.sliceIndex &&
        settled.sliceIndex !== track.start.sliceIndex
        ? settled.sliceIndex
        : anchors.sliceIndex
      : settled.sliceIndex;
  let ww = settled.ww;
  let wc = settled.wc;
  if (
    anchors?.ww != null &&
    anchors.wc != null &&
    Number.isFinite(anchors.ww) &&
    Number.isFinite(anchors.wc)
  ) {
    const copiesStart =
      track.start.ww != null &&
      track.start.wc != null &&
      voiClose(anchors.ww, anchors.wc, track.start.ww, track.start.wc);
    const copiesSettled =
      settled.ww != null &&
      settled.wc != null &&
      voiClose(anchors.ww, anchors.wc, settled.ww, settled.wc);
    if (copiesStart && settled.ww != null && settled.wc != null && !copiesSettled) {
      ww = settled.ww;
      wc = settled.wc;
    } else {
      ww = anchors.ww;
      wc = anchors.wc;
    }
  }
  const point = anchors?.point ?? settled.point;
  let zoom = settled.zoom;
  if (anchors?.zoom != null && Number.isFinite(anchors.zoom)) {
    const pan = anchors.pan ?? zoom?.pan ?? [0, 0];
    const panMag = Math.hypot(pan[0], pan[1]);
    zoom =
      Math.abs(anchors.zoom - 1) >= ZOOM_EPS || panMag >= PAN_EPS
        ? { zoom: anchors.zoom, pan }
        : undefined;
  }
  return {
    ...settled,
    sliceIndex: slice,
    ww,
    wc,
    zoom,
    point,
  };
}

function finalRunStart(
  samples: Array<{ t: number; hit: boolean }>
): number | null {
  let run: number | null = null;
  let seen = false;
  for (const sample of samples) {
    if (sample.hit) {
      if (!seen) run = sample.t;
      seen = true;
    } else if (seen) {
      run = null;
      seen = false;
    }
  }
  return run;
}

function sliceTime(track: RecordedTrack, sliceIndex: number): number {
  const t = finalRunStart(
    track.events
      .filter((e): e is Extract<RecordedEvent, { type: "slice" }> => e.type === "slice")
      .map((e) => ({ t: e.t, hit: e.index === sliceIndex }))
  );
  return t ?? 0;
}

function windowTime(track: RecordedTrack, ww: number, wc: number): number | null {
  return finalRunStart(
    track.events
      .filter((e): e is Extract<RecordedEvent, { type: "voi" }> => e.type === "voi")
      .map((e) => ({ t: e.t, hit: voiClose(e.ww, e.wc, ww, wc) }))
  );
}

function zoomTime(track: RecordedTrack, zoom: number, pan: [number, number]): number | null {
  return finalRunStart(
    track.events
      .filter((e): e is Extract<RecordedEvent, { type: "camera" }> => e.type === "camera")
      .map((e) => ({
        t: e.t,
        hit:
          Math.abs(e.zoom - zoom) < ZOOM_EPS &&
          Math.hypot(e.pan[0] - pan[0], e.pan[1] - pan[1]) < PAN_EPS,
      }))
  );
}

function pointTime(track: RecordedTrack, point: { x: number; y: number }): number | null {
  let best: { t: number; d: number } | null = null;
  for (const event of track.events) {
    if (event.type !== "cursor") continue;
    const d = Math.hypot(event.x - point.x, event.y - point.y);
    if (d > POINT_EPS) continue;
    if (!best || d < best.d || (d === best.d && event.t > best.t)) {
      best = { t: event.t, d };
    }
  }
  return best?.t ?? lastOf(track, "cursor")?.t ?? null;
}

function placeTimes(preferred: number[], duration: number): number[] {
  const n = preferred.length;
  if (n === 0) return [];
  const span = Math.max(0, duration);
  const gap = Math.min(420, Math.max(1, Math.floor(span / n)));
  const out: number[] = [];
  let prev = -gap;
  for (let i = 0; i < n; i++) {
    const room = Math.max(0, span - (n - 1 - i) * gap);
    const want = Number.isFinite(preferred[i]) ? preferred[i] : 0;
    const at = Math.min(room, Math.max(prev + gap, want));
    out.push(Math.max(0, at));
    prev = out[i];
  }
  return out;
}

function spokenWindow(ww: number, wc: number): string {
  const w = Math.round(ww);
  const c = Math.round(wc);
  if (ww >= 1000 && wc <= -400) {
    return `Lung windows, ${w} over ${c}. Air and vessels read here; soft tissue hides them.`;
  }
  if (ww >= 1400 && wc >= 200) {
    return `Bone windows, ${w} over ${c}. Look at the cortex, not the soft tissue.`;
  }
  if (ww <= 250 && wc >= 20 && wc <= 90) {
    return `Brain windows, ${w} over ${c}. Grey-white contrast lives here.`;
  }
  if (ww >= 300 && ww <= 500 && wc >= 0 && wc <= 80) {
    return `Soft-tissue windows, ${w} over ${c}. Notice what the lung window was hiding.`;
  }
  return `Window ${w} over ${c}. Notice what this setting shows that the last one hid.`;
}

function findingCorpus(anchors?: SparseAnchors): string {
  return [anchors?.label, anchors?.description, ...(anchors?.teachingPoints ?? [])]
    .filter((s): s is string => Boolean(s?.trim()))
    .join(" ");
}

interface DraftAct {
  act: TeachAct;
  preferredT: number;
  actions: TeachViewerAction[];
  stem: string;
}

function annotationAction(
  e: Extract<RecordedEvent, { type: "annotation" }>
): TeachViewerAction {
  const { t: _t, type: _type, ...stroke } = e;
  return { type: "annotate", ...stroke };
}

function measureLine(action: TeachViewerAction | undefined): string {
  if (!action || action.type !== "annotate") return "";
  if (action.lengthMm != null && Number.isFinite(action.lengthMm)) {
    return `It measures ${Math.round(action.lengthMm)} millimetres.`;
  }
  return "";
}

/**
 * Collapse a dense record into five attending acts at most.
 * Values come from the committed anchors. Times come from the final run
 * that landed on each anchor, then forced into orient → pearl order so a
 * point-before-window fumble is not what the registrar sees.
 */
export function buildTeachingGuide(
  track: RecordedTrack,
  opts?: { narration?: NarrationSpan[]; anchors?: SparseAnchors }
): TeachingGuide {
  const money = resolveMoney(track, opts?.anchors);
  const duration = Math.max(0, track.durationMs);
  const drafts: DraftAct[] = [];

  const scroll: TeachViewerAction = {
    type: "scroll",
    sliceIndex: money.sliceIndex,
    ...(money.series ? { seriesInstanceUID: money.series } : {}),
  };
  drafts.push({
    act: "orient",
    preferredT: sliceTime(track, money.sliceIndex),
    actions: [scroll],
    stem: "Follow the stack.",
  });

  if (money.ww != null && money.wc != null && Number.isFinite(money.ww) && Number.isFinite(money.wc)) {
    const actions: TeachViewerAction[] = [{ type: "window", ww: money.ww, wc: money.wc }];
    if (money.invert) actions.push({ type: "invert", value: true });
    drafts.push({
      act: "search",
      preferredT: windowTime(track, money.ww, money.wc) ?? 0,
      actions,
      stem: spokenWindow(money.ww, money.wc),
    });
  }

  if (money.zoom) {
    drafts.push({
      act: "lean-in",
      preferredT: zoomTime(track, money.zoom.zoom, money.zoom.pan) ?? 0,
      actions: [{ type: "zoom", zoom: money.zoom.zoom, pan: money.zoom.pan }],
      stem: `Lean in, about ${money.zoom.zoom.toFixed(1)} times. Stay on this slice and look at the edge.`,
    });
  }

  const commitActions: TeachViewerAction[] = [];
  if (money.point) commitActions.push({ type: "point", x: money.point.x, y: money.point.y });
  if (money.annotation) commitActions.push(annotationAction(money.annotation));
  if (commitActions.length) {
    const pointed = money.point ? pointTime(track, money.point) : null;
    drafts.push({
      act: "commit",
      preferredT: pointed ?? money.annotation?.t ?? 0,
      actions: commitActions,
      stem: sentence(
        ["Look here.", measureLine(commitActions.find((a) => a.type === "annotate"))]
          .filter(Boolean)
          .join(" ")
      ),
    });
  }

  const times = placeTimes(
    drafts.map((d) => d.preferredT),
    Math.max(duration, 1)
  );
  const beats: TeachBeat[] = drafts.map((draft, i) => ({
    t: times[i] ?? 0,
    act: draft.act,
    actions: draft.actions,
    say: sentence(draft.stem),
  }));

  const corpus = findingCorpus(opts?.anchors);
  const spans = normalizeNarrationSpans(opts?.narration ?? track.narration, Math.max(duration, 1));
  const used = new Set<number>();
  beats.forEach((beat, i) => {
    if (beat.act === "pearl") return;
    const end = beats[i + 1]?.t ?? Math.max(duration, beat.t + 1);
    const hit = spans.findIndex((span, idx) => {
      if (used.has(idx)) return false;
      const mid = (span.tStartMs + span.tEndMs) / 2;
      if (mid < beat.t || mid >= end) return false;
      return !overlapsFinding(span.text, corpus);
    });
    if (hit < 0) return;
    used.add(hit);
    beat.say = `${beat.say} ${sentence(spans[hit].text)}`.trim();
  });

  const held = spans.filter((_, idx) => !used.has(idx)).map((span) => span.text);
  const pearlT = (beats[beats.length - 1]?.t ?? 0) + 1;
  beats.push({
    t: Math.min(Math.max(duration, pearlT), Math.max(pearlT, times[times.length - 1] ?? 0) + 1),
    act: "pearl",
    actions: [],
    say: pearlSay(opts?.anchors, held),
  });
  // Keep pearl strictly after the last drive so the name is not spoken on the way in.
  const lastDrive = beats[beats.length - 2];
  const pearl = beats[beats.length - 1];
  if (lastDrive && pearl.t <= lastDrive.t) pearl.t = lastDrive.t + 1;

  return {
    durationMs: duration,
    start: {
      sliceIndex: track.start.sliceIndex,
      ww: track.start.ww,
      wc: track.start.wc,
    },
    beats,
  };
}

function pearlSay(anchors: SparseAnchors | undefined, held: string[]): string {
  const parts: string[] = [];
  const desc = anchors?.description?.trim();
  if (desc) parts.push(sentence(desc));
  for (const point of anchors?.teachingPoints ?? []) {
    const line = point.trim();
    if (!line) continue;
    if (desc && mostlyCovered(line, desc)) continue;
    parts.push(sentence(line));
  }
  let corpus = parts.join(" ");
  for (const line of held) {
    if (!overlapsFinding(line, findingCorpus(anchors)) && parts.length > 0) continue;
    if (mostlyCovered(line, corpus)) continue;
    const next = sentence(line);
    parts.push(next);
    corpus = `${corpus} ${next}`;
  }
  if (parts.length) return parts.join(" ");
  const label = anchors?.label?.trim();
  if (label) return sentence(`This is ${label}`);
  return "Say what you see on this slice, and what goes in the report.";
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

/** Guide for one finding track. Anchors are the landing; narration is the clock. */
export function guideForFindingTrack(
  track: RecordedTrack,
  narration: {
    description?: string;
    teachingPoints?: string[];
    label?: string;
    spans?: NarrationSpan[];
    sliceIndex?: number;
    ww?: number;
    wc?: number;
    point?: { x: number; y: number };
  }
): TeachingGuide {
  return buildTeachingGuide(track, {
    narration: narration.spans ?? track.narration,
    anchors: {
      label: narration.label,
      description: narration.description,
      teachingPoints: narration.teachingPoints,
      sliceIndex: narration.sliceIndex,
      ww: narration.ww,
      wc: narration.wc,
      point: narration.point,
    },
  });
}

/**
 * Precedence, highest first:
 * 1. RecordedTrack — rebuild with buildTeachingGuide from the track and the
 *    current prose. A stored teachingGuide is ignored, including the LIDC
 *    demo script.
 * 2. Stored teachingGuide — demo fallback when the finding has no teacher track.
 * 3. null — nothing to play.
 *
 * A re-record or an edit to the label, description, or teaching points
 * replaces what Teach says, because the track is the source.
 */
export function resolveTeachingGuide(
  finding: Pick<
    Finding,
    | "track"
    | "teachingGuide"
    | "description"
    | "teachingPoints"
    | "label"
    | "sliceIndex"
    | "windowWidth"
    | "windowCenter"
    | "marker"
  >
): TeachingGuide | null {
  if (finding.track && (finding.track.events?.length || finding.track.durationMs > 0)) {
    return guideForFindingTrack(finding.track, {
      label: finding.label,
      description: finding.description,
      teachingPoints: finding.teachingPoints,
      sliceIndex: finding.sliceIndex,
      ww: finding.windowWidth,
      wc: finding.windowCenter,
      point:
        finding.marker &&
        Number.isFinite(finding.marker.x_pct) &&
        Number.isFinite(finding.marker.y_pct)
          ? { x: finding.marker.x_pct, y: finding.marker.y_pct }
          : undefined,
    });
  }
  if (finding.teachingGuide?.beats?.length) return finding.teachingGuide;
  return null;
}

export function guideHasMotion(guide: TeachingGuide | null | undefined): boolean {
  if (!guide) return false;
  return guide.beats.some((b) => b.actions.length > 0 || Boolean(b.say?.trim()));
}

/**
 * Beat lines Teach should speak. A non-empty list is the narration;
 * an empty list is the silent-guide case, which falls through to
 * `tutorSpeechPlan` instead of playing with a blank Discussion.
 */
export function authoredGuideLines(
  guide: Pick<TeachingGuide, "beats"> | null | undefined
): string[] {
  if (!guide) return [];
  return guide.beats
    .map((beat) => beat.say?.trim() ?? "")
    .filter((line) => line.length > 0);
}

/** Compact tutor line — the ordered script, not the stats digest. */
export function formatTeachingGuideLine(guide: TeachingGuide | null | undefined): string {
  if (!guide?.beats?.length) return "";
  const bits: string[] = [];
  for (const beat of guide.beats) {
    if (beat.act) bits.push(beat.act);
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
  const more = countActions(guide) > bits.filter((b) => !b.startsWith("say:") && !isAct(b)).length;
  return `guide=[${bits.join(" → ")}${more ? " → …" : ""}]`;
}

function isAct(bit: string): boolean {
  return bit === "orient" || bit === "search" || bit === "lean-in" || bit === "commit" || bit === "pearl";
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
 * Transcript spans stay on the track so a later session can rebuild the script.
 */
export function withRecordedTeaching<T extends Partial<Finding>>(
  base: T,
  track: RecordedTrack,
  narration: {
    description?: string;
    teachingPoints?: string[];
    label?: string;
    spans?: NarrationSpan[];
  },
  liveMeasurements?: FindingMeasurement[]
): T {
  const spans = normalizeNarrationSpans(
    narration.spans ?? track.narration,
    Math.max(1, track.durationMs)
  );
  const stored: RecordedTrack = spans.length ? { ...track, narration: spans } : { ...track };
  const teachingGuide = guideForFindingTrack(stored, {
    label: narration.label ?? base.label,
    description: narration.description,
    teachingPoints: narration.teachingPoints,
    spans: stored.narration,
    point:
      base.marker && Number.isFinite(base.marker.x_pct) && Number.isFinite(base.marker.y_pct)
        ? { x: base.marker.x_pct, y: base.marker.y_pct }
        : undefined,
  });
  const measurements = mergeMeasurements(liveMeasurements, measurementsFromTrack(track));
  return {
    ...base,
    track: stored,
    durationMs: track.durationMs,
    teachingGuide,
    ...(measurements.length ? { measurements } : {}),
  };
}
