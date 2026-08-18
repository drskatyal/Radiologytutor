/**
 * Voice seam — live tutor speech for Layer 3 (Q&A), never recorded tracks.
 *
 * Priority:
 *   1. ElevenLabs + teacher voiceId (authentic clone)
 *   2. Gemini TTS (platform default)
 *   3. Caller falls back to browser speechSynthesis
 *
 * Gemini Live (realtime native audio) is the latency escape hatch — see
 * `preferRealtimeFallback` / docs/CONSULTANT_READING.md. Mint a short-lived
 * token via `/api/voice/realtime` when TTS exceeds VOICE_LATENCY_BUDGET_MS.
 */

import { geminiConfigured, synthesizeSpeech } from "./gemini";
import {
  elevenLabsConfigured,
  elevenLabsSynthesize,
} from "./elevenlabs";

export type VoiceProvider = "elevenlabs" | "gemini_tts" | "realtime" | "none";

export type TutorSpeech = {
  audio: Buffer;
  mimeType: string;
  provider: VoiceProvider;
  /** Wall time for this synthesis (ms) — client uses vs VOICE_LATENCY_BUDGET_MS. */
  latencyMs: number;
  /** True when synthesis exceeded the soft budget (prefer Gemini Live next turn). */
  exceededBudget: boolean;
};

export type SynthesizeTutorOpts = {
  text: string;
  /** ElevenLabs voice id from Author.voice.voiceId */
  voiceId?: string | null;
  /**
   * When true and ELEVENLABS is slow/unavailable, callers should open the
   * Gemini Live path instead of waiting on this promise. We still try TTS
   * here; the flag is advisory for the client/orchestrator.
   */
  preferRealtimeFallback?: boolean;
};

/** Soft latency budget before the client should prefer Gemini Live (ms). */
export const VOICE_LATENCY_BUDGET_MS = Number(
  process.env.VOICE_LATENCY_BUDGET_MS || 1200
);

export function voiceStackStatus(): {
  elevenLabs: boolean;
  geminiTts: boolean;
  realtimeAvailable: boolean;
  primary: VoiceProvider;
  latencyBudgetMs: number;
} {
  const elevenLabs = elevenLabsConfigured();
  const geminiTts = geminiConfigured();
  return {
    elevenLabs,
    geminiTts,
    // Live API uses the same Gemini key; client mints via /api/voice/realtime.
    realtimeAvailable: geminiTts,
    primary: elevenLabs ? "elevenlabs" : geminiTts ? "gemini_tts" : "none",
    latencyBudgetMs: VOICE_LATENCY_BUDGET_MS,
  };
}

/**
 * Synthesize a live tutor turn. Recorded lesson narration must NEVER call this.
 */
export async function synthesizeTutorSpeech(
  opts: SynthesizeTutorOpts
): Promise<TutorSpeech> {
  const text = opts.text.trim();
  if (!text) throw new Error("text is required for tutor speech.");

  const started = Date.now();
  const voiceId = opts.voiceId?.trim();
  let audio: Buffer | null = null;
  let mimeType = "audio/mpeg";
  let provider: VoiceProvider = "none";

  if (voiceId && elevenLabsConfigured()) {
    try {
      const r = await elevenLabsSynthesize(text, voiceId);
      audio = r.audio;
      mimeType = r.mimeType;
      provider = "elevenlabs";
    } catch (err) {
      // Fall through to Gemini TTS — authenticity preferred, availability required.
      console.warn("[voice] ElevenLabs failed, falling back to Gemini TTS:", err);
    }
  }

  if (!audio) {
    if (!geminiConfigured()) {
      throw new Error(
        "No TTS provider configured (set ELEVENLABS_API_KEY or GEMINI_API_KEY)."
      );
    }
    const r = await synthesizeSpeech(text);
    audio = r.audio;
    mimeType = r.mimeType;
    provider = "gemini_tts";
  }

  const latencyMs = Date.now() - started;
  return {
    audio,
    mimeType,
    provider,
    latencyMs,
    exceededBudget: latencyMs > VOICE_LATENCY_BUDGET_MS,
  };
}

/**
 * Gemini Live model id for the realtime fallback path.
 * Override with GEMINI_LIVE_MODEL when Google ships a newer Live Flash.
 */
export function geminiLiveModelId(): string {
  return (
    process.env.GEMINI_LIVE_MODEL?.trim() ||
    "gemini-live-2.5-flash-native-audio"
  );
}

/** Whether the orchestrator should advertise realtime as an alternative. */
export function realtimeVoiceAvailable(): boolean {
  return geminiConfigured();
}
