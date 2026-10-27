/**
 * Compile a continuous teaching take into structured findings.
 *
 * Flash hears the audio and, when present, sees a sparse strip of viewport
 * stills. The call goes through `lib/gemini.ts` `generate` — the same
 * generateContent Flash the rest of the app uses (`GEMINI_MODEL`, default
 * gemini-3.8-flash). This module does not name a separate model.
 *
 * Time ranges come from the model. Marker and slice landings do not: they are
 * read from the recorded track with markerNearTime / sliceNearTime. A coordinate
 * the model emits is discarded.
 */

import {
  coerceCompileFrames,
  compileVideoProcessing,
  prepareCompileFrames,
  trackClockSummary,
  type CompileFrame,
} from "./compileMedia";
import {
  markerNearTime,
  segmentMidMs,
  seriesNearTime,
  sliceNearTime,
  sliceTrack,
} from "./captureSession";
import { generate, parseJsonLoose, userParts, type GeminiPart } from "./gemini";
import { materializeLiveTeachingPack } from "./liveTeachingPack";
import { STRUCTURE_FINDING_SYSTEM, STRUCTURE_SESSION_SYSTEM } from "./teachingPrompt";
import { guideForFindingTrack } from "./teachingGuide";
import type { Finding, RecordedTrack, StructuredSession, StructuredSessionFinding } from "./types";

const STILL_ADDENDUM = `

Viewport stills:
- Timestamped stills of the imaging viewport may be attached. Each still is introduced by "Viewport still at t=<ms>."
- Use the stills together with the audio to decide finding boundaries and what was on screen.
- Do NOT output pixel coordinates, marker positions, or slice indices. The server places those from the viewer log.
- Never invent a lesion, measurement, or diagnosis that was neither spoken nor clearly visible in a still.`;

export interface CompileVideo {
  base64: string;
  mimeType: string;
}

export interface CompileSessionInput {
  audioBase64?: string;
  audioMime?: string;
  transcript?: string;
  durationMs: number;
  track?: RecordedTrack;
  frames?: CompileFrame[];
  /**
   * Viewer-only recording of the take. Long takes are sent to Flash with
   * agentic video processing. This file is never forwarded to Gemini Live.
   */
  video?: CompileVideo;
  caseId?: string;
  modality?: string;
  clinicalQuestion?: string;
  diagnosis?: string;
  studySeriesUIDs?: string[];
}

export interface CompileGenerateOpts {
  systemInstruction: string;
  temperature: number;
  jsonOnly: boolean;
  contents: { role: "user"; parts: GeminiPart[] }[];
}

export type CompileGenerate = (opts: CompileGenerateOpts) => Promise<{ text: string }>;

export function findingSystemInstruction(hasFrames: boolean): string {
  if (!hasFrames) return STRUCTURE_FINDING_SYSTEM;
  return (
    STRUCTURE_FINDING_SYSTEM +
    "\n\nViewport stills of the imaging surface are attached, each labeled with tMs. Describe only what was said and shown. Do not invent measurements, markers, or slice numbers."
  );
}

export function compileSessionRequest(input: CompileSessionInput): {
  systemInstruction: string;
  parts: GeminiPart[];
} {
  const durationMs = Number(input.durationMs) || 0;
  const videoProcessing = input.video?.base64 ? compileVideoProcessing(durationMs) : null;
  // A long recording is explored by Flash. Attaching the still strip as well
  // would tokenize the same pixels twice. Short takes keep static video plus stills.
  const frames =
    videoProcessing === "AGENTIC" ? [] : prepareCompileFrames(input.frames);
  const hint = input.transcript?.trim() ?? "";
  const clock = trackClockSummary(input.track);
  const hintBlock = hint
    ? `Here is the transcript (prefer this if audio is also provided):\n${hint}\n\n`
    : "";
  const classic =
    `Session durationMs=${durationMs || "unknown"}. ` +
    `Transcribe (if needed) and segment into teaching findings with time ranges.`;
  const text = frames.length
    ? [
        hintBlock.trimEnd(),
        `Session durationMs=${durationMs || "unknown"}.`,
        `${frames.length} viewport stills are attached. Hear the audio and look at the stills, then segment teaching findings.`,
        clock ? `Viewer log clock (no coordinates — do not copy positions into JSON):\n${clock}` : "",
        "Return transcript plus findings with tStartMs and tEndMs only. Do not include coordinates or slice indices.",
      ]
        .filter(Boolean)
        .join("\n\n")
    : hintBlock + classic + (clock ? `\n\nViewer log clock (do not copy positions into JSON):\n${clock}` : "");

  return {
    systemInstruction: frames.length ? STRUCTURE_SESSION_SYSTEM + STILL_ADDENDUM : STRUCTURE_SESSION_SYSTEM,
    parts: userParts({
      text,
      audioBase64: input.audioBase64,
      audioMime: input.audioBase64 ? input.audioMime : undefined,
      video: input.video?.base64
        ? {
            data: input.video.base64,
            mimeType: input.video.mimeType || "video/webm",
            mediaProcessing: videoProcessing ?? "STATIC",
          }
        : undefined,
      images: frames.map((frame) => ({
        mimeType: frame.mimeType,
        data: frame.base64,
        caption: `Viewport still at t=${frame.tMs}ms.`,
      })),
    }),
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
    const text = (key: string): string | undefined => {
      const value = prose[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const mimics = Array.isArray(prose.mimics)
      ? prose.mimics.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const importance = Number(prose.clinicalImportance);
    const sub = track ? sliceTrack(track, tStart, tEnd) : undefined;
    // Marker, slice, window, and series stay on the track. Model coordinates are dropped.
    return {
      label: typeof f.label === "string" && f.label.trim() ? f.label.trim() : `Finding ${i + 1}`,
      description,
      teachingPoints,
      whatToNotice: text("whatToNotice") ?? (description || undefined),
      pearl: text("pearl") ?? teachingPoints[0],
      mimics: mimics.length ? mimics : teachingPoints.slice(1),
      ...(Number.isFinite(importance) && importance >= 1 ? { clinicalImportance: Math.round(importance) } : {}),
      whyClinicallyFirst: text("whyClinicallyFirst"),
      reportLine: text("reportLine"),
      landmark: text("landmark"),
      tStartMs: tStart,
      tEndMs: tEnd,
      suggestedMarker: markerNearTime(track, mid) ?? undefined,
      suggestedSliceIndex: sliceNearTime(track, mid) ?? undefined,
      teachingGuide: sub ? guideForFindingTrack(sub, { description, teachingPoints }) : undefined,
    };
  });
}

export async function compileStructuredSession(
  input: CompileSessionInput,
  generateFn: CompileGenerate = generate
): Promise<StructuredSession> {
  const transcriptHint = input.transcript?.trim() ?? "";
  if (!input.audioBase64 && !transcriptHint && !input.video?.base64) {
    throw new Error("audioBase64 or transcript is required");
  }
  const durationMs = Number(input.durationMs) || 0;
  const request = compileSessionRequest({ ...input, durationMs, transcript: transcriptHint });
  const result = await generateFn({
    systemInstruction: request.systemInstruction,
    temperature: 0.15,
    jsonOnly: true,
    contents: [{ role: "user", parts: request.parts }],
  });
  const parsed = parseJsonLoose<Partial<StructuredSession>>(result.text);
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = materializeFindings(rawFindings, durationMs, input.track);
  return {
    transcript:
      typeof parsed.transcript === "string" && parsed.transcript.trim()
        ? parsed.transcript.trim()
        : transcriptHint,
    findings,
    liveTeachingPack: packFromCompiledFindings(input, findings),
  };
}

/** Drive anchors from the track clock. Flash prose is copied. Model coordinates are already gone. */
function packFromCompiledFindings(
  input: CompileSessionInput,
  findings: StructuredSessionFinding[]
): StructuredSession["liveTeachingPack"] {
  const drafts: Finding[] = findings.map((segment, index) => {
    const mid = segmentMidMs(segment.tStartMs, segment.tEndMs);
    const sub = input.track ? sliceTrack(input.track, segment.tStartMs, segment.tEndMs) : undefined;
    return {
      id: `seg_${index}`,
      label: segment.label,
      description: segment.description,
      teachingPoints: segment.teachingPoints,
      state: " ",
      marker: segment.suggestedMarker ?? { x_pct: 0.5, y_pct: 0.5, shape: "circle" },
      order: segment.clinicalImportance ?? index + 1,
      sliceIndex: segment.suggestedSliceIndex,
      seriesInstanceUID: seriesNearTime(input.track, mid) ?? undefined,
      windowWidth: sub?.start.ww,
      windowCenter: sub?.start.wc,
      track: sub,
      teachingGuide: segment.teachingGuide,
      tStartMs: segment.tStartMs,
      tEndMs: segment.tEndMs,
      landmark: segment.landmark,
    };
  });
  return materializeLiveTeachingPack({
    caseId: input.caseId || "compile",
    modality: input.modality || "CT",
    clinicalQuestion: input.clinicalQuestion,
    diagnosis: input.diagnosis,
    findings: drafts,
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
