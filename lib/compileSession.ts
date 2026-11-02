/**
 * Compile a continuous teaching take into structured findings.
 *
 * Flash hears the audio and, when present, sees a sparse strip of viewport
 * stills or a viewport-only recording. The call goes through `lib/gemini.ts`
 * `generate` — the same generateContent Flash the rest of the app uses
 * (`GEMINI_MODEL`, default gemini-3.8-flash). This module does not name a
 * separate model.
 *
 * Time ranges come from the model. Marker and slice landings do not: they are
 * read from the recorded track with markerNearTime / sliceNearTime. A coordinate
 * the model emits is discarded. Takes of at least five minutes upload through
 * the Files API and use agentic video. Shorter recordings stay on static
 * frames plus the still strip.
 */

import {
  AGENTIC_VIDEO_MIN_MS,
  compileVideoProcessing,
  prepareCompileFrames,
  trackClockSummary,
  type CompileFrame,
} from "./compileMedia";
import { markerNearTime, segmentMidMs, sliceNearTime, sliceTrack } from "./captureSession";
import { generate, parseJsonLoose, userParts, type GeminiPart } from "./gemini";
import { findingsFromCompiledTake, materializeLiveTeachingPack } from "./liveTeachingPack";
import { STRUCTURE_FINDING_SYSTEM, STRUCTURE_SESSION_SYSTEM } from "./teachingPrompt";
import { guideForFindingTrack } from "./teachingGuide";
import type { RecordedTrack, StructuredSession, StructuredSessionFinding } from "./types";

/** Long viewport recordings. Short takes stay on stills and do not attach a file. */
export const AGENTIC_COMPILE_TIMEOUT_MS = 180_000;

const STILL_ADDENDUM = `

Viewport stills:
- Timestamped stills of the imaging viewport may be attached. Each still is introduced by "Viewport still at t=<ms>."
- Use the stills together with the audio to decide finding boundaries and what was on screen.
- Do NOT output pixel coordinates, marker positions, or slice indices. The server places those from the viewer log.
- Never invent a lesion, measurement, or diagnosis that was neither spoken nor clearly visible in a still.`;

export interface CompileVideo {
  /** Inline bytes. Used for a short take, or a long take that was not uploaded. */
  base64?: string;
  /** Files API URI. Attached only when the take is long enough for agentic video. */
  fileUri?: string;
  mimeType: string;
}

export interface CompileStudyContext {
  title?: string;
  modality?: string;
  specialty?: string;
  clinicalHistory?: string;
  patientAge?: string;
  patientSex?: string;
}

export interface CompileSessionInput {
  audioBase64?: string;
  audioMime?: string;
  transcript?: string;
  durationMs: number;
  track?: RecordedTrack;
  frames?: CompileFrame[];
  /**
   * Viewer-only recording of the take. Long takes go to Flash as a Files API
   * video with agentic processing. Short takes may send inline bytes as static
   * video plus stills. This file is never forwarded to Gemini Live.
   */
  video?: CompileVideo;
  caseId?: string;
  modality?: string;
  clinicalQuestion?: string;
  diagnosis?: string;
  studySeriesUIDs?: string[];
  /** Case stem Flash may use as context. It is not a source of coordinates. */
  study?: CompileStudyContext;
}

export interface CompileGenerateOpts {
  systemInstruction: string;
  temperature: number;
  jsonOnly: boolean;
  contents: { role: "user"; parts: GeminiPart[] }[];
  timeoutMs?: number;
}

export type CompileGenerate = (opts: CompileGenerateOpts) => Promise<{ text: string }>;

export function viewportVideoPart(video: CompileVideo): GeminiPart {
  return {
    fileData: {
      fileUri: video.fileUri || "",
      mimeType: video.mimeType || "video/webm",
    },
    mediaProcessing: "AGENTIC",
    mediaResolution: "MEDIA_RESOLUTION_LOW",
  };
}

export function findingSystemInstruction(hasFrames: boolean): string {
  if (!hasFrames) return STRUCTURE_FINDING_SYSTEM;
  return (
    STRUCTURE_FINDING_SYSTEM +
    "\n\nViewport stills of the imaging surface are attached, each labeled with tMs. Describe only what was said and shown. Do not invent measurements, markers, or slice numbers."
  );
}

function oneLine(value: string | undefined, max = 400): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Study stem for the compile prompt. Omitted entirely when the caller has none. */
export function compileStudyBlock(study: CompileStudyContext | undefined): string {
  if (!study) return "";
  const lines = [
    oneLine(study.title) && `Title: ${oneLine(study.title)}`,
    oneLine(study.modality) && `Modality: ${oneLine(study.modality)}`,
    oneLine(study.specialty) && `Specialty: ${oneLine(study.specialty)}`,
    oneLine(study.clinicalHistory, 800) && `Clinical history: ${oneLine(study.clinicalHistory, 800)}`,
    oneLine(study.patientAge) && `Patient age: ${oneLine(study.patientAge)}`,
    oneLine(study.patientSex) && `Patient sex: ${oneLine(study.patientSex)}`,
  ].filter((line): line is string => Boolean(line));
  if (!lines.length) return "";
  return `Study metadata (context only — do not invent a finding from it, and do not emit coordinates):\n${lines.join("\n")}`;
}

function importanceRank(value: unknown, index: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return index + 1;
  return Math.round(n);
}

/** Keep Flash's clinical-importance order. Missing ranks stay in speech order. */
export function orderCompiledFindings(
  findings: StructuredSessionFinding[]
): StructuredSessionFinding[] {
  return findings
    .map((finding, index) => ({
      finding,
      index,
      rank: importanceRank(finding.clinicalImportance, index),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((row, index) => ({ ...row.finding, clinicalImportance: index + 1 }));
}

function filesApiUri(uri: string | undefined): string | undefined {
  const value = uri?.trim() ?? "";
  return value.startsWith("https://generativelanguage.googleapis.com/") ? value : undefined;
}

export function compileSessionRequest(input: CompileSessionInput): {
  systemInstruction: string;
  parts: GeminiPart[];
  agenticVideo: boolean;
} {
  const durationMs = Number(input.durationMs) || 0;
  const fileUri = filesApiUri(input.video?.fileUri);
  const inlineBase64 = input.video?.base64?.trim() ?? "";
  const longTake = durationMs >= AGENTIC_VIDEO_MIN_MS;
  const agenticFile = Boolean(fileUri) && longTake;
  const agenticInline = Boolean(inlineBase64) && longTake && !agenticFile;
  const agenticVideo = agenticFile || agenticInline;
  // A long recording is explored by Flash. Attaching the still strip as well
  // would tokenize the same pixels twice. Short takes keep static video plus stills.
  const frames = agenticVideo ? [] : prepareCompileFrames(input.frames);
  const hint = input.transcript?.trim() ?? "";
  const clock = trackClockSummary(input.track);
  const hintBlock = hint
    ? `Here is the transcript (prefer this if audio is also provided):\n${hint}\n\n`
    : "";
  const classic =
    `Session durationMs=${durationMs || "unknown"}. ` +
    `Transcribe (if needed) and segment into teaching findings with time ranges.`;
  const clockBlock = clock
    ? `Viewer log clock (no coordinates — do not copy positions into JSON):\n${clock}`
    : "";
  const body = agenticVideo
    ? [
        hintBlock.trimEnd(),
        `Session durationMs=${durationMs}.`,
        "A DICOM viewport recording is attached. Use it with the viewer log. Do not read the rest of the page — the file is the viewport only.",
        clockBlock,
        "Return transcript plus findings with whatToNotice, pearl, mimics, tStartMs, tEndMs, and clinicalImportance only. Do not include coordinates or slice indices.",
      ]
        .filter(Boolean)
        .join("\n\n")
    : frames.length
      ? [
          hintBlock.trimEnd(),
          `Session durationMs=${durationMs || "unknown"}.`,
          `${frames.length} viewport stills are attached. Hear the audio and look at the stills, then segment teaching findings.`,
          clockBlock,
          "Return transcript plus findings with tStartMs and tEndMs only. Do not include coordinates or slice indices.",
        ]
          .filter(Boolean)
          .join("\n\n")
      : hintBlock + classic + (clock ? `\n\nViewer log clock (do not copy positions into JSON):\n${clock}` : "");
  const study = compileStudyBlock(input.study);
  const text = study ? `${body}\n\n${study}` : body;
  const parts = userParts({
    text,
    audioBase64: input.audioBase64,
    audioMime: input.audioBase64 ? input.audioMime : undefined,
    video:
      !agenticFile && inlineBase64
        ? {
            data: inlineBase64,
            mimeType: input.video?.mimeType || "video/webm",
            mediaProcessing: agenticInline ? "AGENTIC" : compileVideoProcessing(durationMs),
          }
        : undefined,
    images: frames.map((frame) => ({
      mimeType: frame.mimeType,
      data: frame.base64,
      caption: `Viewport still at t=${frame.tMs}ms.`,
    })),
  });
  if (agenticFile && fileUri) {
    parts.unshift(viewportVideoPart({ fileUri, mimeType: input.video?.mimeType || "video/webm" }));
  }

  return {
    systemInstruction: frames.length ? STRUCTURE_SESSION_SYSTEM + STILL_ADDENDUM : STRUCTURE_SESSION_SYSTEM,
    parts,
    agenticVideo,
  };
}

function materializeFindings(
  rawFindings: unknown[],
  durationMs: number,
  track: RecordedTrack | undefined
): StructuredSessionFinding[] {
  return rawFindings.map((raw, i) => {
    const f = (raw ?? {}) as Partial<StructuredSessionFinding>;
    let tStart = Number(f.tStartMs);
    let tEnd = Number(f.tEndMs);
    if (!Number.isFinite(tStart)) tStart = 0;
    if (!Number.isFinite(tEnd) || tEnd <= tStart) {
      const n = Math.max(1, rawFindings.length);
      const span = Math.max(1, durationMs || 1000);
      tStart = Math.round((i / n) * span);
      tEnd = Math.round(((i + 1) / n) * span);
    }
    if (durationMs > 0) {
      tStart = Math.max(0, Math.min(durationMs, tStart));
      tEnd = Math.max(tStart + 1, Math.min(durationMs, tEnd));
    }
    const mid = segmentMidMs(tStart, tEnd);
    const description = typeof f.description === "string" ? f.description : "";
    const teachingPoints = Array.isArray(f.teachingPoints)
      ? f.teachingPoints.filter((point): point is string => typeof point === "string")
      : [];
    const prose = f as StructuredSessionFinding & Record<string, unknown>;
    const textOf = (key: string): string | undefined => {
      const value = prose[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const mimics = Array.isArray(prose.mimics)
      ? prose.mimics.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const importance = Number(prose.clinicalImportance);
    const sub = track ? sliceTrack(track, tStart, tEnd) : undefined;
    const whatToNotice = textOf("whatToNotice") ?? (description || undefined);
    // Marker, slice, window, and series stay on the track. Model coordinates are dropped.
    return {
      label: typeof f.label === "string" && f.label.trim() ? f.label.trim() : `Finding ${i + 1}`,
      description,
      teachingPoints,
      whatToNotice,
      pearl: textOf("pearl") ?? teachingPoints[0],
      mimics: mimics.length ? mimics : teachingPoints.slice(1),
      ...(Number.isFinite(importance) && importance >= 1 ? { clinicalImportance: Math.round(importance) } : {}),
      whyClinicallyFirst: textOf("whyClinicallyFirst"),
      reportLine: textOf("reportLine"),
      landmark: textOf("landmark"),
      tStartMs: tStart,
      tEndMs: tEnd,
      suggestedMarker: markerNearTime(track, mid) ?? undefined,
      suggestedSliceIndex: sliceNearTime(track, mid) ?? undefined,
      teachingGuide: sub
        ? guideForFindingTrack(sub, { description: whatToNotice ?? description, teachingPoints })
        : undefined,
    };
  });
}

export async function compileStructuredSession(
  input: CompileSessionInput,
  generateFn: CompileGenerate = generate
): Promise<StructuredSession> {
  const transcriptHint = input.transcript?.trim() ?? "";
  const hasVideo = Boolean(input.video?.base64?.trim() || filesApiUri(input.video?.fileUri));
  if (!input.audioBase64 && !transcriptHint && !hasVideo) {
    throw new Error("audioBase64 or transcript is required");
  }
  const durationMs = Number(input.durationMs) || 0;
  const request = compileSessionRequest({ ...input, durationMs, transcript: transcriptHint });
  const result = await generateFn({
    systemInstruction: request.systemInstruction,
    temperature: 0.15,
    jsonOnly: true,
    contents: [{ role: "user", parts: request.parts }],
    ...(request.agenticVideo ? { timeoutMs: AGENTIC_COMPILE_TIMEOUT_MS } : {}),
  });
  const parsed = parseJsonLoose<Partial<StructuredSession>>(result.text);
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = orderCompiledFindings(materializeFindings(rawFindings, durationMs, input.track));
  return {
    transcript:
      typeof parsed.transcript === "string" && parsed.transcript.trim()
        ? parsed.transcript.trim()
        : transcriptHint,
    findings,
    liveTeachingPack: packFromCompiledFindings({ ...input, durationMs }, findings),
  };
}

/** Drive anchors from the track clock. Flash prose is copied. Model coordinates are already gone. */
function packFromCompiledFindings(
  input: CompileSessionInput,
  findings: StructuredSessionFinding[]
): StructuredSession["liveTeachingPack"] {
  const track = input.track ?? {
    durationMs: Number(input.durationMs) || 0,
    start: { sliceIndex: 0 },
    events: [],
  };
  const built = input.track
    ? findingsFromCompiledTake({
        captureSessionId: "preview",
        track,
        drafted: findings.map((segment) => ({
          label: segment.label,
          description: segment.description,
          teachingPoints: segment.teachingPoints,
          whatToNotice: segment.whatToNotice,
          pearl: segment.pearl,
          mimics: segment.mimics,
          clinicalImportance: segment.clinicalImportance,
          whyClinicallyFirst: segment.whyClinicallyFirst,
          reportLine: segment.reportLine,
          landmark: segment.landmark,
          tStartMs: segment.tStartMs,
          tEndMs: segment.tEndMs,
        })),
      }).map((finding, index) => ({ ...finding, id: `seg_${index}` }))
    : findings.map((segment, index) => ({
        id: `seg_${index}`,
        label: segment.label,
        description: segment.description,
        teachingPoints: segment.teachingPoints,
        state: " ",
        marker: segment.suggestedMarker ?? { x_pct: 0.5, y_pct: 0.5, shape: "circle" as const },
        order: segment.clinicalImportance ?? index + 1,
        tStartMs: segment.tStartMs,
        tEndMs: segment.tEndMs,
        landmark: segment.landmark,
      }));
  if (!input.track) {
    for (const finding of built) delete (finding as { marker?: unknown }).marker;
  }
  return materializeLiveTeachingPack({
    caseId: input.caseId || "compile",
    modality: input.modality || input.study?.modality || "CT",
    clinicalQuestion: input.clinicalQuestion ?? input.study?.clinicalHistory,
    diagnosis: input.diagnosis,
    findings: built,
    prose: findings.map((segment, index) => ({
      id: `seg_${index}`,
      tStartMs: segment.tStartMs,
      label: segment.label,
      whatToNotice: segment.whatToNotice,
      pearl: segment.pearl,
      mimics: segment.mimics,
      clinicalImportance: segment.clinicalImportance,
      whyClinicallyFirst: segment.whyClinicallyFirst,
      reportLine: segment.reportLine,
      landmark: segment.landmark,
    })),
    studySeriesUIDs: input.studySeriesUIDs,
  });
}
