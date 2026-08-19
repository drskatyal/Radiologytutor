// POST /api/tts
// Body: { text: string, voiceId?: string, authorId?: string }
// Returns: audio bytes (mpeg from ElevenLabs clone, or wav from Gemini TTS).
//
// Live tutor answers ONLY — recorded walk-throughs never route through here.
// Voice selection: explicit voiceId → Author.voice.voiceId → Gemini TTS.
// Headers: X-FlowRad-Voice-Provider, X-FlowRad-Voice-Latency-Ms,
//          X-FlowRad-Voice-Budget-Exceeded (prefer Gemini Live next turn).

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId } from "@/lib/auth";
import { getAuthor } from "@/lib/cases";
import {
  synthesizeTutorSpeech,
  voiceStackStatus,
  VOICE_LATENCY_BUDGET_MS,
} from "@/lib/voice";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const stack = voiceStackStatus();
  if (stack.primary === "none") {
    return NextResponse.json(
      { error: "No TTS provider configured", fallback: true },
      { status: 503 }
    );
  }

  try {
    const body = (await req.json()) as {
      text?: string;
      voiceId?: string;
      authorId?: string;
    };
    if (typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    let voiceId = body.voiceId?.trim() || undefined;
    if (!voiceId && body.authorId?.trim()) {
      const orgId = await activeOrgId();
      const author = await getAuthor(orgId, body.authorId.trim());
      if (author?.voice?.status === "ready" && author.voice.voiceId) {
        voiceId = author.voice.voiceId;
      }
    }

    const { audio, mimeType, provider, latencyMs, exceededBudget } =
      await synthesizeTutorSpeech({
        text: body.text,
        voiceId,
      });

    return new NextResponse(audio as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-store",
        "X-FlowRad-Voice-Provider": provider,
        "X-FlowRad-Voice-Latency-Ms": String(latencyMs),
        "X-FlowRad-Voice-Budget-Ms": String(VOICE_LATENCY_BUDGET_MS),
        "X-FlowRad-Voice-Budget-Exceeded": exceededBudget ? "1" : "0",
        // Hint: open Gemini Live when TTS is too slow for conversational feel.
        ...(exceededBudget
          ? { "X-FlowRad-Prefer-Realtime": "/api/voice/realtime" }
          : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, fallback: true }, { status: 502 });
  }
}
