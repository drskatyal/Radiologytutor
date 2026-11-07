// POST /api/structure-session
// Continuous authoring take → ordered findings with time ranges.
// Body: { audioBase64?, audioMime?, transcript?, durationMs, track?, frames?, video? }
//
// Gemini Flash (the shared generateContent stack) hears the audio and, when
// the author captured them, sees viewport stills or a long viewport recording.
// We then enrich each segment with suggestedMarker / suggestedSliceIndex from
// the recorded track clock so landings are real viewer samples — never
// coordinates the model invented.
// A separate speech-to-text pass is optional scaffolding, not required.

import { NextRequest, NextResponse } from "next/server";
import { coerceCompileFrames } from "@/lib/compileMedia";
import { compileStructuredSession, type CompileStudyContext, type CompileVideo } from "@/lib/compileSession";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import type { RecordedTrack } from "@/lib/types";

function videoOf(body: {
  video?: unknown;
  videoBase64?: unknown;
  videoMime?: unknown;
}): CompileVideo | undefined {
  const raw = body.video;
  const fromObject = raw && typeof raw === "object" ? (raw as { fileUri?: unknown; mimeType?: unknown; base64?: unknown }) : undefined;
  const fileUri = typeof fromObject?.fileUri === "string" ? fromObject.fileUri.trim() : "";
  const inline = typeof body.videoBase64 === "string" && body.videoBase64
    ? body.videoBase64
    : typeof fromObject?.base64 === "string"
      ? fromObject.base64
      : "";
  const mimeSource =
    (typeof body.videoMime === "string" && body.videoMime) ||
    (typeof fromObject?.mimeType === "string" && fromObject.mimeType) ||
    "video/webm";
  const mimeType = mimeSource.startsWith("video/") ? mimeSource : "video/webm";
  const trustedFile = fileUri.startsWith("https://generativelanguage.googleapis.com/") ? fileUri : undefined;
  if (!trustedFile && !inline) return undefined;
  return {
    mimeType,
    ...(trustedFile ? { fileUri: trustedFile } : {}),
    ...(inline ? { base64: inline } : {}),
  };
}

function studyContext(raw: unknown): CompileStudyContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const pick = (key: keyof CompileStudyContext) =>
    typeof source[key] === "string" ? (source[key] as string).trim() : undefined;
  const study: CompileStudyContext = {
    title: pick("title"),
    modality: pick("modality"),
    specialty: pick("specialty"),
    clinicalHistory: pick("clinicalHistory"),
    patientAge: pick("patientAge"),
    patientSex: pick("patientSex"),
  };
  return Object.values(study).some(Boolean) ? study : undefined;
}

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireAuthorOrg();
    const body = await req.json();
    const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : undefined;
    const audioMime = (body.audioMime as string | undefined) || "audio/webm";
    const durationMs = Number(body.durationMs) || 0;
    const track = body.track as RecordedTrack | undefined;
    const transcriptHint = typeof body.transcript === "string" ? body.transcript.trim() : "";
    const video = videoOf(body);
    if (!audioBase64 && !transcriptHint && !video) {
      return NextResponse.json(
        { error: "audioBase64 or transcript is required" },
        { status: 400 }
      );
    }

    const session = await compileStructuredSession({
      audioBase64,
      audioMime: audioBase64 ? audioMime : undefined,
      transcript: transcriptHint,
      durationMs,
      track,
      frames: coerceCompileFrames(body.frames),
      video,
      caseId: typeof body.caseId === "string" ? body.caseId : undefined,
      modality: typeof body.modality === "string" ? body.modality : undefined,
      clinicalQuestion: typeof body.clinicalQuestion === "string" ? body.clinicalQuestion : undefined,
      diagnosis: typeof body.diagnosis === "string" ? body.diagnosis : undefined,
      studySeriesUIDs: Array.isArray(body.studySeriesUIDs)
        ? body.studySeriesUIDs.filter((uid: unknown) => typeof uid === "string")
        : undefined,
      study: studyContext(body.study),
    });

    return NextResponse.json(session);
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message === "audioBase64 or transcript is required" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
