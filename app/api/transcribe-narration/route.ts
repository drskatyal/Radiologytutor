// POST /api/transcribe-narration
// Body: { audio: { base64, mime? }, durationMs }
// Reply: { transcript, spans: NarrationSpan[], alignment: "estimated" | "proportional" }
//
// Author save uses this so a recorded take becomes timed narration for the
// teach script. It is STT plus alignment only — not the teaching plan.
// When the model does not return usable times, spans are word-weighted
// slices of the verbatim transcript (constant speech rate, not a forced aligner).

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { geminiConfigured, transcribeNarrationTake } from "@/lib/gemini";
import { coerceNarrationSpans } from "@/lib/teachingGuide";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!geminiConfigured()) {
    return NextResponse.json(
      { error: "Voice transcription is unavailable — GEMINI_API_KEY is not set." },
      { status: 503 }
    );
  }

  try {
    await requireAuthorOrg();
    const body = await req.json();
    const base64 = body?.audio?.base64;
    const mime = typeof body?.audio?.mime === "string" ? body.audio.mime : "audio/webm";
    const durationMs = Number(body?.durationMs);
    if (typeof base64 !== "string" || !base64) {
      return NextResponse.json({ error: "audio.base64 is required" }, { status: 400 });
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return NextResponse.json({ error: "durationMs is required" }, { status: 400 });
    }

    const taken = await transcribeNarrationTake(base64, mime, durationMs);
    const aligned = coerceNarrationSpans(taken.segments, taken.transcript, durationMs);
    return NextResponse.json({
      transcript: taken.transcript,
      spans: aligned.spans,
      alignment: aligned.alignment,
    });
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = /GEMINI_API_KEY/i.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
