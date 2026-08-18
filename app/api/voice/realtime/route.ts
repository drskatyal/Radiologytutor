// POST /api/voice/realtime — mint a Gemini Live ephemeral token (latency fallback).
// GET  /api/voice/realtime — capability info (model, ws URL, soft budget).
//
// The browser never sees GEMINI_API_KEY. After minting, it opens Google's
// Live WebSocket with the short-lived token. Recorded walk-throughs never
// use this path — only Layer 3 live Q&A when ElevenLabs/TTS is too slow.

import { NextResponse } from "next/server";
import {
  getRealtimeVoiceInfo,
  mintRealtimeEphemeralToken,
} from "@/lib/voiceRealtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getRealtimeVoiceInfo());
}

export async function POST() {
  const info = getRealtimeVoiceInfo();
  if (!info.available) {
    return NextResponse.json(
      { error: "Gemini Live unavailable — set GEMINI_API_KEY.", available: false },
      { status: 503 }
    );
  }

  try {
    const token = await mintRealtimeEphemeralToken();
    return NextResponse.json({
      available: true,
      ...token,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Still advertise capability so the UI can show "configure key" vs hard fail.
    return NextResponse.json(
      {
        error: message,
        available: info.available,
        model: info.model,
        preferAfterMs: info.preferAfterMs,
        fallback: "tts",
      },
      { status: 502 }
    );
  }
}
