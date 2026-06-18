// POST /api/tts
// Body: { text: string }
// Returns: audio/wav bytes synthesized by Gemini TTS (the tutor's voice).
//
// Server-only — keeps GEMINI_API_KEY off the client. This is the SAME vendor
// seam as the rest of our AI (one key: GEMINI_API_KEY). If the key is missing
// or synthesis fails, we return a JSON error with `fallback: true` so the
// client gracefully falls back to the browser's built-in speechSynthesis.
//
// Used ONLY for live tutor answers — the teacher's recorded lesson narration
// is its own audio and is never routed through here.

import { NextRequest, NextResponse } from "next/server";
import { geminiConfigured, synthesizeSpeech } from "@/lib/gemini";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!geminiConfigured()) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not set", fallback: true },
      { status: 503 }
    );
  }

  try {
    const { text } = await req.json();
    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const { audio, mimeType } = await synthesizeSpeech(text);

    return new NextResponse(audio as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, fallback: true }, { status: 502 });
  }
}
