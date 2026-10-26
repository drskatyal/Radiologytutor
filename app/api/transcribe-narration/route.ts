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
import { narrationRequestFromBody, publishNarrationTake } from "@/lib/teachingGuide";

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
    const parsed = narrationRequestFromBody(await req.json());
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const taken = await transcribeNarrationTake(
      parsed.audioBase64,
      parsed.mime,
      parsed.durationMs
    );
    return NextResponse.json(publishNarrationTake(taken, parsed.durationMs));
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = /GEMINI_API_KEY/i.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
