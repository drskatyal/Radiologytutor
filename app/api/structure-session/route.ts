// POST /api/structure-session
// Continuous authoring take → ordered findings with time ranges.
// Body: { audioBase64?, audioMime?, transcript?, durationMs, track?, frames? }
//
// Gemini Flash (the shared generateContent stack) hears the audio and, when
// the author captured them, sees viewport stills. We then enrich each segment
// with suggestedMarker / suggestedSliceIndex from the recorded track clock so
// landings are real viewer samples — never coordinates the model invented.
// A separate speech-to-text pass is optional scaffolding, not required.

import { NextRequest, NextResponse } from "next/server";
import { coerceCompileFrames } from "@/lib/compileMedia";
import { compileStructuredSession } from "@/lib/compileSession";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import type { RecordedTrack } from "@/lib/types";

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

    const videoBase64 = typeof body.videoBase64 === "string" ? body.videoBase64 : "";
    const videoMime = typeof body.videoMime === "string" ? body.videoMime : "video/webm";
    if (!audioBase64 && !transcriptHint && !videoBase64) {
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
      video: videoBase64 ? { base64: videoBase64, mimeType: videoMime } : undefined,
      caseId: typeof body.caseId === "string" ? body.caseId : undefined,
      modality: typeof body.modality === "string" ? body.modality : undefined,
      clinicalQuestion: typeof body.clinicalQuestion === "string" ? body.clinicalQuestion : undefined,
      diagnosis: typeof body.diagnosis === "string" ? body.diagnosis : undefined,
      studySeriesUIDs: Array.isArray(body.studySeriesUIDs)
        ? body.studySeriesUIDs.filter((uid: unknown) => typeof uid === "string")
        : undefined,
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
