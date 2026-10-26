/**
 * Compile a continuous teaching take into structured findings.
 *
 * Flash hears the audio and, when present, sees a sparse strip of viewport
 * stills. The call goes through `lib/gemini.ts` `generate` — the same
 * generateContent Flash the rest of the app uses (`GEMINI_MODEL`, default
 * gemini-3.7-flash). This module does not name a separate model.
 *
 * Time ranges come from the model. Marker and slice landings do not: they are
 * read from the recorded track with markerNearTime / sliceNearTime. A coordinate
 * the model emits is discarded.
 */

import {
  coerceCompileFrames,
  prepareCompileFrames,
  trackClockSummary,
  type CompileFrame,
} from "./compileMedia";
import {
  markerNearTime,
  segmentMidMs,
  sliceNearTime,
  sliceTrack,
} from "./captureSession";
import { generate, parseJsonLoose, userParts, type GeminiPart } from "./gemini";
import { STRUCTURE_FINDING_SYSTEM, STRUCTURE_SESSION_SYSTEM } from "./teachingPrompt";
import { guideForFindingTrack } from "./teachingGuide";
import type { RecordedTrack, StructuredSession, StructuredSessionFinding } from "./types";

const STILL_ADDENDUM = `

Viewport stills:
- Timestamped stills of the imaging viewport may be attached. Each still is introduced by "Viewport still at t=<ms>."
- Use the stills together with the audio to decide finding boundaries and what was on screen.
- Do NOT output pixel coordinates, marker positions, or slice indices. The server places those from the viewer log.
- Never invent a lesion, measurement, or diagnosis that was neither spoken nor clearly visible in a still.`;

export interface CompileSessionInput {
  audioBase64?: string;
  audioMime?: string;
  transcript?: string;
  durationMs: number;
  track?: RecordedTrack;
  frames?: CompileFrame[];
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
  const frames = prepareCompileFrames(input.frames);
  const durationMs = Number(input.durationMs) || 0;
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
    const sub = track ? sliceTrack(track, tStart, tEnd) : undefined;
    return {
      label: typeof f.label === "string" && f.label.trim() ? f.label.trim() : `Finding ${i + 1}`,
      description,
      teachingPoints,
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
  if (!input.audioBase64 && !transcriptHint) {
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
  return {
    transcript:
      typeof parsed.transcript === "string" && parsed.transcript.trim()
        ? parsed.transcript.trim()
        : transcriptHint,
    findings: materializeFindings(rawFindings, durationMs, input.track),
  };
}
