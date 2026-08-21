// POST /api/tts
// Body: { text: string, authorId?: string }
// Returns: audio bytes (mpeg from ElevenLabs clone, or wav from Gemini TTS).
//
// Live tutor answers ONLY — recorded walk-throughs never route through here.
// Voice selection: Author.voice.voiceId (resolved server-side, in the caller's
// own org) → Gemini TTS. A client-supplied voiceId is ignored by design.
// Headers: X-FlowRad-Voice-Provider, X-FlowRad-Voice-Latency-Ms,
//          X-FlowRad-Voice-Budget-Exceeded (prefer Gemini Live next turn).

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
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
    await requireSession();
    const body = (await req.json()) as {
      text?: string;
      voiceId?: string;
      authorId?: string;
    };
    if (typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    // A client-supplied `voiceId` is NOT trusted: it would let any caller drive
    // any voice in the provider account. The voice is always resolved from an
    // author record in the caller's own org; anything else falls back to the
    // default synthetic voice.
    let voiceId: string | undefined;
    const requestedAuthorId = body.authorId?.trim();
    if (requestedAuthorId) {
      const orgId = await activeOrgId();
      const author = await getAuthor(orgId, requestedAuthorId);
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
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, fallback: true }, { status: 502 });
  }
}
