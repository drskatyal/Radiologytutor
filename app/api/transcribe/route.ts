// POST /api/transcribe  — CALL 1 of the student voice Q&A flow (CLAUDE.md §2).
//
// Body:  { audio: { base64: string; mime?: string } }
// Reply: { transcript: string }            (200)
//        { error: string }                  (4xx/5xx)
//
// This is STT ONLY — Gemini transcribes the spoken question to text. The
// teaching reasoning happens in the SEPARATE /api/tutor call. We never merge
// the two. Gemini runs server-side; the key never reaches the client.

import { NextRequest, NextResponse } from "next/server";
import { geminiConfigured, transcribeAudio } from "@/lib/gemini";
import { jsonAuthError, requireSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!geminiConfigured()) {
    return NextResponse.json(
      { error: "Voice transcription is unavailable — GEMINI_API_KEY is not set." },
      { status: 503 }
    );
  }

  try {
    await requireSession();
    const { audio } = await req.json();
    const base64 = audio?.base64;
    if (typeof base64 !== "string" || !base64) {
      return NextResponse.json({ error: "audio.base64 is required" }, { status: 400 });
    }

    const transcript = await transcribeAudio(base64, audio?.mime || "audio/webm");
    return NextResponse.json({ transcript });
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
