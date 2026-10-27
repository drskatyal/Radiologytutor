/**
 * What Gemini Live teaches from.
 *
 * Flash may write the prose (what to notice, the pearl, mimics, clinical
 * order). It may not place the viewer. Drive anchors are copied from the
 * saved finding and its recorded track. A coordinate, slice, window, or
 * series UID that arrived in model JSON is ignored.
 *
 * `set_series` uses one argument list on Live and on the text tutor:
 * seriesInstanceUID plus optional sliceIndex, ww, and wc. Live rejects a
 * UID, slice, or window that is not on this pack. The text tutor drops a
 * UID that is not in the same authored set (rail, study refs, findings,
 * drive, compare, authoredSeriesInstanceUIDs).
 */

import {
  compareNearTime,
  markerNearTime,
  segmentMidMs,
  seriesNearTime,
  sliceNearTime,
  sliceTrack,
} from "./captureSession";
import { secondaryAnchor } from "./findingAnchors";
import { formatMeasurementBrief, measurementsFromTrack } from "./findingMeasurements";
import { guideForFindingTrack } from "./teachingGuide";
import type { Finding, FindingAnchor, Marker, RecordedTrack, TeachAct } from "./types";

export type LiveMode = "examiner" | "teach_me";

export type LiveAct = TeachAct;

export interface LiveDrivePoint {
  x_pct: number;
  y_pct: number;
}

export interface LiveDriveMeasurement {
  tool: string;
  valueText: string;
}

export interface LiveDriveCompare {
  seriesInstanceUID?: string;
  sliceIndex?: number;
  ww?: number;
  wc?: number;
  marker?: LiveDrivePoint;
}

export interface LiveDrive {
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  /** 0-based Cornerstone index. */
  sliceIndex?: number;
  ww?: number;
  wc?: number;
  marker?: LiveDrivePoint;
  measurements?: LiveDriveMeasurement[];
  /** Authored camera from the viewer log. Tool results only — never the spoken instruction. */
  zoom?: number;
  panX?: number;
  panY?: number;
  compare?: LiveDriveCompare;
}

export interface LiveFinding {
  id: string;
  /** 1 = most important. */
  clinicalImportance: number;
  whyClinicallyFirst?: string;
  label: string;
  whatToNotice: string;
  pearl: string;
  mimics: string[];
  reportLine?: string;
  landmark?: string;
  drive: LiveDrive;
  acts: Array<{ act: LiveAct; say: string }>;
}

export interface LiveTeachingPack {
  caseId: string;
  modality: string;
  clinicalQuestion?: string;
  /** Withheld from the examiner prompt until the learner asks to be taught. */
  diagnosis?: string;
  /** Finding ids sorted by clinicalImportance (most urgent first). */
  findingOrder: string[];
  findings: LiveFinding[];
  /**
   * Series the teacher put on this case. `set_series` rejects anything else.
   * Recomputed from findings, anchors, recorded series changes, and study refs.
   */
  authoredSeriesInstanceUIDs: string[];
}

export interface LiveProse {
  id?: string;
  tStartMs?: number;
  label?: string;
  clinicalImportance?: number;
  whyClinicallyFirst?: string;
  whatToNotice?: string;
  pearl?: string;
  mimics?: string[];
  reportLine?: string;
  landmark?: string;
}

export interface LiveToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const ACTS: readonly LiveAct[] = ["orient", "search", "lean-in", "commit", "pearl"];

/** Stable argument names for the series sidepane. Do not rename these. */
export const SET_SERIES_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    seriesInstanceUID: {
      type: "string",
      description: "Series Instance UID copied from authoredSeriesInstanceUIDs",
    },
    sliceIndex: {
      type: "number",
      description: "Optional 0-based slice index on that series",
    },
    ww: { type: "number", description: "Optional window width" },
    wc: { type: "number", description: "Optional window center" },
  },
  required: ["seriesInstanceUID"],
};

export const LIVE_PACK_TOOLS: LiveToolDeclaration[] = [
  {
    name: "show_finding",
    description:
      "Seat an authored finding: its series, slice, window, and marker. Pass the finding id from the pack. Do not invent an id.",
    parameters: {
      type: "object",
      properties: { findingId: { type: "string" } },
      required: ["findingId"],
    },
  },
  {
    name: "set_window",
    description: "Set window width and center from that finding's drive.ww and drive.wc. Do not invent a window.",
    parameters: {
      type: "object",
      properties: {
        windowWidth: { type: "number" },
        windowCenter: { type: "number" },
      },
      required: ["windowWidth", "windowCenter"],
    },
  },
  {
    name: "point_to",
    description:
      "Point at an authored marker. Prefer findingId. Otherwise copy drive.marker x_pct and y_pct. Never invent a coordinate.",
    parameters: {
      type: "object",
      properties: {
        findingId: { type: "string" },
        x_pct: { type: "number" },
        y_pct: { type: "number" },
      },
    },
  },
  {
    name: "scroll_to",
    description:
      "Scroll to an authored 0-based sliceIndex. Copy it from drive.sliceIndex. Pass seriesInstanceUID when the drive names one.",
    parameters: {
      type: "object",
      properties: {
        sliceIndex: { type: "number" },
        seriesInstanceUID: { type: "string" },
        findingId: { type: "string" },
      },
      required: ["sliceIndex"],
    },
  },
  {
    name: "zoom_to",
    description: "Lean in. Copy zoom from the finding act, or use a modest zoom on the authored marker. Do not invent a lesion location.",
    parameters: {
      type: "object",
      properties: {
        zoom: { type: "number" },
        panX: { type: "number" },
        panY: { type: "number" },
        findingId: { type: "string" },
      },
      required: ["zoom"],
    },
  },
  {
    name: "draw_annotation",
    description: "Draw the authored measurement for a finding. Pass findingId. Do not invent endpoints.",
    parameters: {
      type: "object",
      properties: {
        findingId: { type: "string" },
        tool: { type: "string" },
        x_pct: { type: "number" },
        y_pct: { type: "number" },
        x2_pct: { type: "number" },
        y2_pct: { type: "number" },
      },
    },
  },
  {
    name: "next_finding",
    description: "Advance to the next id in findingOrder (clinical importance). Do not skip ahead unless the learner asks.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "set_series",
    description:
      "Switch the viewer to an authored series so a multi-series study (MRI sequences, priors) can be taught. seriesInstanceUID must be one of authoredSeriesInstanceUIDs. Optional sliceIndex is 0-based. Optional ww and wc apply after the series loads. Never invent a series UID.",
    parameters: SET_SERIES_PARAMETERS,
  },
  {
    name: "web_search",
    description:
      "Search the web for a guideline, lexicon, or criterion the learner asked about. Keep the spoken claim tied to this case.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

export type SetSeriesCall =
  | {
      ok: true;
      seriesInstanceUID: string;
      sliceIndex?: number;
      ww?: number;
      wc?: number;
    }
  | { ok: false; error: string };

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function pointOf(marker: Marker | { x_pct?: number; y_pct?: number } | null | undefined): LiveDrivePoint | undefined {
  const x = finite(marker?.x_pct);
  const y = finite(marker?.y_pct);
  if (x == null || y == null) return undefined;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x_pct: x, y_pct: y };
}

function addUid(into: Set<string>, uid: string | null | undefined): void {
  const value = uid?.trim();
  if (value) into.add(value);
}

/** Series a teacher actually put on the case. Model-invented UIDs never enter this set. */
export function authoredSeriesFromFindings(
  findings: readonly Finding[],
  studySeriesUIDs?: readonly string[]
): string[] {
  const uids = new Set<string>();
  for (const uid of studySeriesUIDs ?? []) addUid(uids, uid);
  for (const finding of findings) {
    addUid(uids, finding.seriesInstanceUID);
    for (const anchor of finding.anchors ?? []) addUid(uids, anchor.seriesInstanceUID);
    for (const event of finding.track?.events ?? []) {
      if (event.type === "series") addUid(uids, event.seriesInstanceUID);
    }
  }
  return [...uids];
}

function driveFromFinding(finding: Finding): LiveDrive {
  const compare = secondaryAnchor(finding);
  const measurements = (finding.measurements ?? [])
    .map((item) => ({ tool: item.kind, valueText: formatMeasurementBrief(item) }))
    .filter((item) => item.valueText.trim());
  const drive: LiveDrive = {};
  const series = finding.seriesInstanceUID?.trim();
  if (series) drive.seriesInstanceUID = series;
  const sop = finding.sopInstanceUID?.trim();
  if (sop) drive.sopInstanceUID = sop;
  const slice = finite(finding.sliceIndex);
  if (slice != null) drive.sliceIndex = Math.max(0, Math.round(slice));
  const ww = finite(finding.windowWidth);
  const wc = finite(finding.windowCenter);
  if (ww != null) drive.ww = ww;
  if (wc != null) drive.wc = wc;
  const marker = pointOf(finding.marker);
  if (marker) drive.marker = marker;
  if (measurements.length) drive.measurements = measurements;
  const camera = cameraFromFinding(finding);
  if (camera.zoom != null) drive.zoom = camera.zoom;
  if (camera.panX != null && camera.panY != null) {
    drive.panX = camera.panX;
    drive.panY = camera.panY;
  }
  if (compare) {
    const next: LiveDriveCompare = {};
    const compareSeries = compare.seriesInstanceUID?.trim();
    if (compareSeries) next.seriesInstanceUID = compareSeries;
    const compareSlice = finite(compare.sliceIndex);
    if (compareSlice != null) next.sliceIndex = Math.max(0, Math.round(compareSlice));
    const compareWw = finite(compare.windowWidth);
    const compareWc = finite(compare.windowCenter);
    if (compareWw != null) next.ww = compareWw;
    if (compareWc != null) next.wc = compareWc;
    const compareMarker = pointOf(compare.marker);
    if (compareMarker) next.marker = compareMarker;
    if (Object.keys(next).length) drive.compare = next;
  }
  return drive;
}

function cameraFromFinding(finding: Finding): { zoom?: number; panX?: number; panY?: number } {
  let zoom: number | undefined;
  let panX: number | undefined;
  let panY: number | undefined;
  const take = (z: number, pan?: [number, number]) => {
    if (!Number.isFinite(z)) return;
    zoom = z;
    if (pan && Number.isFinite(pan[0]) && Number.isFinite(pan[1])) {
      panX = pan[0];
      panY = pan[1];
    }
  };
  for (const event of finding.track?.events ?? []) {
    if (event.type === "camera") take(event.zoom, event.pan);
  }
  for (const beat of finding.teachingGuide?.beats ?? []) {
    for (const action of beat.actions) {
      if (action.type === "zoom") take(action.zoom, action.pan);
    }
  }
  return { zoom, panX, panY };
}

function actsFromFinding(finding: Finding): LiveFinding["acts"] {
  const beats = finding.teachingGuide?.beats ?? [];
  return beats.flatMap((beat) => {
    const say = beat.say?.trim();
    if (!say || !beat.act || !ACTS.includes(beat.act)) return [];
    return [{ act: beat.act, say }];
  });
}

function importanceOf(value: unknown, fallback: number): number {
  const n = finite(value);
  if (n == null || n < 1) return fallback;
  return Math.round(n);
}

function matchProse(finding: Finding, prose: readonly LiveProse[], prior: LiveFinding | undefined): LiveProse | undefined {
  return (
    prose.find((item) => item.id && item.id === finding.id) ??
    prose.find((item) => finite(item.tStartMs) != null && finite(item.tStartMs) === finite(finding.tStartMs)) ??
    prose.find((item) => item.label && finding.label && item.label.trim() === finding.label.trim()) ??
    (prior
      ? {
          whatToNotice: prior.whatToNotice,
          pearl: prior.pearl,
          mimics: prior.mimics,
          clinicalImportance: prior.clinicalImportance,
          whyClinicallyFirst: prior.whyClinicallyFirst,
          reportLine: prior.reportLine,
          landmark: prior.landmark,
        }
      : undefined)
  );
}

function teacherOrder(findings: readonly Finding[]): string[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => a.finding.order - b.finding.order || a.index - b.index)
    .map((item) => item.finding.id);
}

/**
 * Build a pack from saved findings. Prose may come from Flash or from a pack
 * already stored on the case. Drive is always the finding, never the prose.
 */
export function materializeLiveTeachingPack(input: {
  caseId: string;
  modality: string;
  clinicalQuestion?: string;
  diagnosis?: string;
  findings: readonly Finding[];
  prose?: readonly LiveProse[];
  prior?: LiveTeachingPack | null;
  studySeriesUIDs?: readonly string[];
}): LiveTeachingPack {
  const prose = input.prose ?? [];
  const priorById = new Map((input.prior?.findings ?? []).map((item) => [item.id, item]));
  const savedOrder = teacherOrder(input.findings);
  const priorOrder = input.prior?.findingOrder ?? [];
  const sameOrder =
    priorOrder.length > 0 &&
    savedOrder.length === priorOrder.length &&
    savedOrder.every((id, index) => id === priorOrder[index]);

  const findings: LiveFinding[] = input.findings.map((finding, index) => {
    const prior = priorById.get(finding.id);
    const note = matchProse(finding, prose, prior);
    const fallbackRank = savedOrder.indexOf(finding.id) + 1 || index + 1;
    const rank = sameOrder
      ? importanceOf(note?.clinicalImportance ?? prior?.clinicalImportance, fallbackRank)
      : fallbackRank;
    const points = finding.teachingPoints.map((item) => item.trim()).filter(Boolean);
    const whatToNotice = cleanText(note?.whatToNotice) ?? cleanText(finding.description) ?? finding.label;
    const pearl = cleanText(note?.pearl) ?? points[0] ?? "";
    const mimics = cleanList(note?.mimics);
    const fromPoints = points.slice(pearl && points[0] === pearl ? 1 : 0);
    return {
      id: finding.id,
      clinicalImportance: rank,
      whyClinicallyFirst: cleanText(note?.whyClinicallyFirst),
      label: finding.label,
      whatToNotice,
      pearl,
      mimics: mimics.length ? mimics : fromPoints,
      reportLine: cleanText(note?.reportLine) ?? cleanText(finding.reportGold),
      landmark: cleanText(note?.landmark) ?? cleanText(finding.landmark),
      drive: driveFromFinding(finding),
      acts: actsFromFinding(finding),
    };
  });

  findings.sort((a, b) => a.clinicalImportance - b.clinicalImportance || a.id.localeCompare(b.id));
  const authored = new Set(authoredSeriesFromFindings(input.findings, input.studySeriesUIDs));
  for (const item of findings) {
    addUid(authored, item.drive.seriesInstanceUID);
    addUid(authored, item.drive.compare?.seriesInstanceUID);
  }

  return {
    caseId: input.caseId,
    modality: input.modality || "CT",
    clinicalQuestion: cleanText(input.clinicalQuestion) ?? cleanText(input.prior?.clinicalQuestion),
    diagnosis: cleanText(input.diagnosis) ?? cleanText(input.prior?.diagnosis),
    findingOrder: findings.map((item) => item.id),
    findings,
    authoredSeriesInstanceUIDs: [...authored],
  };
}

type PackCase = {
  caseId: string;
  modality?: string;
  clinicalHistory?: string;
  primaryDiagnosis?: string;
  findings?: Finding[];
  studyRefs?: { seriesInstanceUIDs?: string[] }[];
  liveTeachingPack?: LiveTeachingPack | null;
};

/** Stored prose is kept. Drive anchors are rebuilt from the findings on the case. */
export function resolveLiveTeachingPack(caseData: PackCase): LiveTeachingPack {
  const findings = caseData.findings ?? [];
  const studySeriesUIDs = (caseData.studyRefs ?? []).flatMap((ref) => ref.seriesInstanceUIDs ?? []);
  return materializeLiveTeachingPack({
    caseId: caseData.caseId,
    modality: caseData.modality || "CT",
    clinicalQuestion: caseData.clinicalHistory,
    diagnosis: caseData.primaryDiagnosis,
    findings,
    prose: caseData.liveTeachingPack?.findings,
    prior: caseData.liveTeachingPack,
    studySeriesUIDs,
  });
}

export function nextFindingId(pack: LiveTeachingPack, currentId: string | null | undefined): string | null {
  const order = pack.findingOrder;
  if (!order.length) return null;
  if (!currentId) return order[0] ?? null;
  const index = order.indexOf(currentId);
  if (index < 0) return order[0] ?? null;
  return order[index + 1] ?? null;
}

/**
 * Accept `set_series` only for an authored UID. Optional slice and window
 * are passed through when they are finite. Loaded UIDs, when provided, must
 * also contain the target or the viewer cannot show it.
 */
export function guardSetSeries(
  allowedSeriesUIDs: readonly string[],
  args: Record<string, unknown>,
  loadedSeriesUIDs?: readonly string[]
): SetSeriesCall {
  const seriesInstanceUID = typeof args.seriesInstanceUID === "string" ? args.seriesInstanceUID.trim() : "";
  if (!seriesInstanceUID) {
    return { ok: false, error: "seriesInstanceUID is required." };
  }
  if (!allowedSeriesUIDs.includes(seriesInstanceUID)) {
    return { ok: false, error: "That series is not authored on this case." };
  }
  if (loadedSeriesUIDs && !loadedSeriesUIDs.includes(seriesInstanceUID)) {
    return { ok: false, error: "That series is not loaded in the viewer." };
  }
  const slice = finite(args.sliceIndex);
  const ww = finite(args.ww);
  const wc = finite(args.wc);
  return {
    ok: true,
    seriesInstanceUID,
    ...(slice != null ? { sliceIndex: Math.max(0, Math.round(slice)) } : {}),
    ...(ww != null ? { ww } : {}),
    ...(wc != null ? { wc } : {}),
  };
}

/** Speakable teaching text. Series UIDs, slices, windows, and markers are not included. */
function speakablePack(pack: LiveTeachingPack, mode: LiveMode, focusFindingId?: string): Record<string, unknown> {
  const findings = pack.findings.map((item) => ({
    id: item.id,
    clinicalImportance: item.clinicalImportance,
    whyClinicallyFirst: item.whyClinicallyFirst,
    label: item.label,
    whatToNotice: item.whatToNotice,
    pearl: item.pearl,
    mimics: item.mimics,
    reportLine: item.reportLine,
    landmark: item.landmark,
    acts: item.acts,
  }));
  return {
    caseId: pack.caseId,
    modality: pack.modality,
    clinicalQuestion: pack.clinicalQuestion,
    ...(mode === "teach_me" && pack.diagnosis ? { diagnosis: pack.diagnosis } : {}),
    findingOrder: pack.findingOrder,
    ...(focusFindingId ? { currentFindingId: focusFindingId } : {}),
    findings,
  };
}

/**
 * Tool list for setup and for context updates. set_series names the authored
 * series here — that list is not part of the spoken system instruction.
 * A context update must send this whole list; a partial list would drop tools.
 */
export function livePackTools(allowedSeries: readonly string[]): LiveToolDeclaration[] {
  const list = allowedSeries.length ? allowedSeries.join(", ") : "(none)";
  return LIVE_PACK_TOOLS.map((tool) => {
    if (tool.name !== "set_series") return tool;
    return {
      ...tool,
      description: `${tool.description} allowedSeries: ${list}. Pass only those seriesInstanceUID values. sliceIndex, ww, and wc must be the numbers returned by show_finding for that series.`,
    };
  });
}

const LOOK_TOOLS =
  "show_finding, set_series, scroll_to, set_window, point_to, zoom_to, draw_annotation, or next_finding";

export function livePackInstruction(
  pack: LiveTeachingPack,
  mode: LiveMode,
  caseTitle?: string,
  focusFindingId?: string
): string {
  const title = caseTitle?.trim() || pack.caseId;
  const modeBlock =
    mode === "examiner"
      ? `ACTIVE MODE: Examiner.
- Evaluate. Ask one question, then wait.
- Hint ladder, one rung at a time: where to look, then the location, then a mimic, then the name.
- Do not speak the diagnosis, the finding label, or the pearl until they name it, exhaust the ladder, or ask to be taught.
- You may call show_finding or set_series so they can look. Do not lecture the case.
- The diagnosis is withheld from this prompt on purpose. Teach it only after they ask.`
      : `ACTIVE MODE: Teach me the case.
- You are the attending. Teach every finding in findingOrder (clinical importance, most urgent first).
- Every turn that tells them where to look MUST call ${LOOK_TOOLS} in the same turn.
- Call show_finding first. Then pass only the series, slice, window, and marker from that tool result into set_series, scroll_to, set_window, point_to, zoom_to, or draw_annotation.
- Say the observation and the report language. Do not turn this into a text chat or a quiz that withholds the case.`;

  return `You are the attending on a live radiology teaching session for "${title}" (${pack.modality}).
The learner is looking at the DICOM viewer. You speak. They can scroll, window, pan, and change series while you talk. Scrolling does not start teaching and is not a request to advance.
Teaching starts because the microphone is open.

This instruction contains only what you may say. It does not contain series UIDs, slice indexes, window values, or marker coordinates. Do not invent them and do not speak them.
Drive anchors were authored from the viewer log. Call show_finding with a finding id. The tool result is the only place those anchors exist. Copy them exactly into set_series({ seriesInstanceUID, sliceIndex?, ww?, wc? }), scroll_to, set_window, point_to, zoom_to, and draw_annotation. The viewer rejects any other value.
set_series may use only a UID from allowedSeries on that tool. Use it when the next look is a different sequence.
next_finding advances findingOrder. web_search is for a guideline or lexicon they asked about. Keep claims tied to this study.
Tool calls are asynchronous. Keep speaking while the viewer moves.

${modeBlock}

TEACHING PACK:
${JSON.stringify(speakablePack(pack, mode, focusFindingId))}`;
}

type DriveHit = {
  findingId: string;
  seriesInstanceUID?: string;
  sliceIndex?: number;
  ww?: number;
  wc?: number;
  marker?: LiveDrivePoint;
  zoom?: number;
  panX?: number;
  panY?: number;
};

function driveHits(pack: LiveTeachingPack): DriveHit[] {
  const hits: DriveHit[] = [];
  for (const item of pack.findings) {
    const drive = item.drive;
    hits.push({
      findingId: item.id,
      seriesInstanceUID: drive.seriesInstanceUID,
      sliceIndex: drive.sliceIndex,
      ww: drive.ww,
      wc: drive.wc,
      marker: drive.marker,
      zoom: drive.zoom,
      panX: drive.panX,
      panY: drive.panY,
    });
    if (drive.compare) {
      hits.push({
        findingId: item.id,
        seriesInstanceUID: drive.compare.seriesInstanceUID ?? drive.seriesInstanceUID,
        sliceIndex: drive.compare.sliceIndex,
        ww: drive.compare.ww,
        wc: drive.compare.wc,
        marker: drive.compare.marker,
      });
    }
  }
  return hits;
}

function near(a: number | undefined, b: number | undefined, eps: number): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= eps;
}

export type LiveToolDecision =
  | { ok: false; error: string; allowedSeries: string[] }
  | {
      ok: true;
      findingId?: string;
      seriesInstanceUID?: string;
      sliceIndex?: number;
      ww?: number;
      wc?: number;
      x_pct?: number;
      y_pct?: number;
      zoom?: number;
      panX?: number;
      panY?: number;
      query?: string;
      /** Authored drive for this finding. Returned to the model on the tool channel. */
      drive?: LiveDrive;
    };

/**
 * Accept a Live tool call only when every number is an authored anchor.
 * show_finding needs only an id — the result carries the drive the other tools must copy.
 */
export function validateLiveToolCall(
  pack: LiveTeachingPack,
  name: string,
  args: Record<string, unknown>,
  currentFindingId?: string
): LiveToolDecision {
  const allowedSeries = pack.authoredSeriesInstanceUIDs;
  const fail = (error: string): LiveToolDecision => ({ ok: false, error, allowedSeries });
  const findingById = (id: string) => pack.findings.find((item) => item.id === id);
  const hits = driveHits(pack);

  if (name === "web_search") {
    const query = cleanText(args.query);
    if (!query) return fail("query is required.");
    return { ok: true, query };
  }

  if (name === "next_finding") {
    const id = nextFindingId(pack, currentFindingId);
    if (!id) return fail("No further authored finding.");
    return { ok: true, findingId: id, drive: findingById(id)?.drive };
  }

  if (name === "show_finding") {
    const id = cleanText(args.findingId);
    const item = id ? findingById(id) : undefined;
    if (!item) return fail("That finding is not on this case.");
    return {
      ok: true,
      findingId: item.id,
      seriesInstanceUID: item.drive.seriesInstanceUID,
      sliceIndex: item.drive.sliceIndex,
      ww: item.drive.ww,
      wc: item.drive.wc,
      x_pct: item.drive.marker?.x_pct,
      y_pct: item.drive.marker?.y_pct,
      zoom: item.drive.zoom,
      panX: item.drive.panX,
      panY: item.drive.panY,
      drive: item.drive,
    };
  }

  if (name === "set_series" || name === "scroll_to") {
    const requested = cleanText(args.seriesInstanceUID);
    const seriesGate =
      name === "set_series"
        ? guardSetSeries(allowedSeries, args)
        : requested
          ? guardSetSeries(allowedSeries, { seriesInstanceUID: requested })
          : { ok: true as const, seriesInstanceUID: undefined };
    if (!seriesGate.ok) return fail(seriesGate.error);
    const seriesInstanceUID = seriesGate.seriesInstanceUID;
    const slice = finite(args.sliceIndex);
    const ww = name === "set_series" ? finite(args.ww) : undefined;
    const wc = name === "set_series" ? finite(args.wc) : undefined;
    const onSeries = hits.filter((hit) => !seriesInstanceUID || hit.seriesInstanceUID === seriesInstanceUID);
    if (slice != null && !onSeries.some((hit) => hit.sliceIndex === slice)) {
      return fail("sliceIndex is not an authored slice on that series.");
    }
    if ((ww != null || wc != null) && !onSeries.some((hit) => near(hit.ww, ww, 1) && near(hit.wc, wc, 1))) {
      return fail("ww/wc is not an authored window on that series.");
    }
    const preferred =
      onSeries.find((hit) => hit.findingId === currentFindingId) ??
      onSeries.find((hit) => slice == null || hit.sliceIndex === slice) ??
      onSeries[0];
    return {
      ok: true,
      findingId: preferred?.findingId,
      seriesInstanceUID,
      sliceIndex: slice ?? preferred?.sliceIndex,
      ww: ww ?? preferred?.ww,
      wc: wc ?? preferred?.wc,
      drive: preferred ? findingById(preferred.findingId)?.drive : undefined,
    };
  }

  if (name === "set_window") {
    const ww = finite(args.windowWidth);
    const wc = finite(args.windowCenter);
    const hit = hits.find((item) => near(item.ww, ww, 1) && near(item.wc, wc, 1));
    if (!hit || ww == null || wc == null) return fail("That window was not authored.");
    return { ok: true, findingId: hit.findingId, ww: hit.ww, wc: hit.wc, drive: findingById(hit.findingId)?.drive };
  }

  if (name === "point_to") {
    const id = cleanText(args.findingId);
    const item = id ? findingById(id) : currentFindingId ? findingById(currentFindingId) : undefined;
    const marker = item?.drive.marker;
    if (!marker) return fail("No authored marker to point at.");
    const x = finite(args.x_pct);
    const y = finite(args.y_pct);
    if ((x != null || y != null) && (!near(x, marker.x_pct, 0.02) || !near(y, marker.y_pct, 0.02))) {
      return fail("That point is not the authored marker.");
    }
    return { ok: true, findingId: item?.id, x_pct: marker.x_pct, y_pct: marker.y_pct, drive: item?.drive };
  }

  if (name === "zoom_to") {
    const zoom = finite(args.zoom);
    const id = cleanText(args.findingId) ?? currentFindingId;
    const item = id ? findingById(id) : undefined;
    const authored = item?.drive.zoom;
    if (authored == null || zoom == null || !near(zoom, authored, 0.05)) {
      return fail("That zoom was not authored for this finding.");
    }
    return {
      ok: true,
      findingId: item?.id,
      zoom: authored,
      panX: item?.drive.panX,
      panY: item?.drive.panY,
      drive: item?.drive,
    };
  }

  if (name === "draw_annotation") {
    const id = cleanText(args.findingId) ?? currentFindingId;
    const item = id ? findingById(id) : undefined;
    if (!item?.drive.measurements?.length) return fail("That finding has no authored measurement.");
    return { ok: true, findingId: item.id, drive: item.drive };
  }

  return fail("That tool is not part of the live teaching pack.");
}

export function liveSessionKick(mode: LiveMode): string {
  if (mode === "examiner") {
    return "The microphone is open. Begin as the examiner. Ask one question about where to look. Seat the slice with a tool. Do not name the diagnosis.";
  }
  return "The microphone is open. Teach me this case. Start with the first finding in findingOrder. Call a drive tool in this turn using its authored anchors, including set_series when that finding is on another series. I may scroll and talk while you teach.";
}

export function liveModeSwitchLine(mode: LiveMode): string {
  if (mode === "examiner") {
    return "Switch to Examiner. Stop lecturing. Ask one question. Withhold the diagnosis. You may still drive the viewer so I can look.";
  }
  return "Switch to Teach me the case. Teach the current finding in clinical order. Every look-cue must call a drive tool with the authored anchors in this turn.";
}

export function liveModeFromSession(mode: string): LiveMode {
  return mode === "viva" || mode === "socratic" || mode === "examiner" ? "examiner" : "teach_me";
}

/**
 * Prose Flash may return for one spoken range. Coordinates are not fields
 * here — the viewer log is the only source of slice, window, series, and pointer.
 */
export interface CompiledTakeDraft {
  label: string;
  description?: string;
  teachingPoints?: string[];
  whatToNotice?: string;
  pearl?: string;
  mimics?: string[];
  /** 1 = must not miss. Missing ranks keep speech order. */
  clinicalImportance?: number;
  whyClinicallyFirst?: string;
  reportLine?: string;
  landmark?: string;
  tStartMs: number;
  tEndMs: number;
}

export interface CompiledTakeCommit {
  captureSessionId: string;
  transcript?: string;
  /** Open series when the log never emitted a series event. Not a model UID. */
  seriesInstanceUID?: string;
  studyInstanceUID?: string;
  findings: CompiledTakeDraft[];
}

function finiteRank(value: unknown, index: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return index + 1;
  return Math.round(n);
}

function cleanLines(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

/**
 * Case findings for one compiled take. Every landing is a sample of `track`
 * at the spoken midpoint. Draft text is label, prose, times, and rank.
 */
export function findingsFromCompiledTake(input: {
  captureSessionId: string;
  track: RecordedTrack;
  drafted: readonly CompiledTakeDraft[];
  seriesInstanceUID?: string;
  studyInstanceUID?: string;
}): Finding[] {
  const ordered = input.drafted
    .filter((draft) => draft.label.trim())
    .map((draft, index) => ({ draft, index, rank: finiteRank(draft.clinicalImportance, index) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);

  return ordered.map((row, index) => {
    const draft = row.draft;
    const tStartMs = Number.isFinite(draft.tStartMs) ? Math.max(0, draft.tStartMs) : 0;
    const tEndMs = Number.isFinite(draft.tEndMs) ? Math.max(tStartMs, draft.tEndMs) : tStartMs;
    const mid = segmentMidMs(tStartMs, tEndMs);
    const sub = sliceTrack(input.track, tStartMs, tEndMs);
    const sampled = markerNearTime(input.track, mid);
    const marker: Marker | undefined = sampled
      ? { x_pct: sampled.x_pct, y_pct: sampled.y_pct, shape: "circle" }
      : undefined;
    const sliceIndex = sliceNearTime(input.track, mid) ?? undefined;
    const series = seriesNearTime(input.track, mid) || input.seriesInstanceUID?.trim() || undefined;
    let ww = input.track.start.ww;
    let wc = input.track.start.wc;
    for (const event of input.track.events) {
      if (event.t > mid) break;
      if (event.type === "voi") {
        ww = event.ww;
        wc = event.wc;
      }
    }
    const points = cleanLines(draft.teachingPoints);
    const whatToNotice = (draft.whatToNotice ?? draft.description ?? "").trim();
    const pearl = (draft.pearl ?? points[0] ?? "").trim();
    const mimics = cleanLines(draft.mimics);
    const teachingPoints = [...new Set([pearl, ...mimics, ...points].filter(Boolean))];
    const measurements = measurementsFromTrack(sub);
    const compare = compareNearTime(input.track, mid);
    const label = draft.label.trim();
    const finding: Finding = {
      id: `lt_${input.captureSessionId}_${index + 1}`,
      label,
      description: whatToNotice || label,
      teachingPoints,
      state: " ",
      marker: marker ?? { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
      track: sub,
      durationMs: sub.durationMs,
      teachingGuide: guideForFindingTrack(sub, {
        label,
        description: whatToNotice,
        teachingPoints,
        sliceIndex,
        ww,
        wc,
        ...(marker ? { point: { x: marker.x_pct, y: marker.y_pct } } : {}),
      }),
      order: index + 1,
      ...(input.studyInstanceUID?.trim() ? { studyInstanceUID: input.studyInstanceUID.trim() } : {}),
      ...(series ? { seriesInstanceUID: series } : {}),
      ...(sliceIndex != null ? { sliceIndex } : {}),
      ...(ww != null && wc != null && Number.isFinite(ww) && Number.isFinite(wc)
        ? { windowWidth: ww, windowCenter: wc }
        : {}),
      ...(measurements.length ? { measurements } : {}),
      captureSessionId: input.captureSessionId,
      tStartMs,
      tEndMs,
      ...(draft.landmark?.trim() ? { landmark: draft.landmark.trim() } : {}),
      ...(draft.reportLine?.trim() ? { reportGold: draft.reportLine.trim() } : {}),
    };
    if (!marker) delete (finding as Partial<Finding>).marker;
    if (compare) {
      const secondary: FindingAnchor = {
        seriesInstanceUID: compare.seriesInstanceUID ?? series,
        ...(input.studyInstanceUID?.trim() ? { studyInstanceUID: input.studyInstanceUID.trim() } : {}),
        sliceIndex: compare.sliceIndex,
        windowWidth: compare.ww,
        windowCenter: compare.wc,
        viewportRole: "secondary",
        ...(compare.marker
          ? { marker: { x_pct: compare.marker.x_pct, y_pct: compare.marker.y_pct, shape: "circle" as const } }
          : {}),
      };
      const anchors: FindingAnchor[] = [];
      if (marker) {
        anchors.push({
          studyInstanceUID: finding.studyInstanceUID,
          seriesInstanceUID: series,
          sliceIndex,
          marker,
          windowWidth: ww,
          windowCenter: wc,
          viewportRole: "primary",
        });
      }
      anchors.push(secondary);
      finding.anchors = anchors;
    }
    return finding;
  });
}
