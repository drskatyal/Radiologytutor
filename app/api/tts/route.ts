// POST /api/tts
// Body: { text: string }
// Returns: audio/mpeg stream from ElevenLabs (the tutor's narration voice).
//
// Server-only — keeps ELEVENLABS_API_KEY off the client. If the key is
// missing, returns 503 so the client can fall back to browser speechSynthesis.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// A warm, clear default voice. Override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY not set", fallback: true },
      { status: 503 }
    );
  }

  try {
    const { text } = await req.json();
    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15 },
        }),
      }
    );

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { error: `ElevenLabs error ${res.status}: ${detail}`, fallback: true },
        { status: 502 }
      );
    }

    // Stream the audio straight through to the browser.
    return new NextResponse(res.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, fallback: true }, { status: 500 });
  }
}
