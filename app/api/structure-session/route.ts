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

    if (!audioBase64 && !transcriptHint) {
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
