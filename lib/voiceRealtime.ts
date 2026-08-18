/**
 * Gemini Live (realtime) capability surface — latency fallback for live Q&A.
 * Full duplex WebSocket wiring lands behind /api/voice/realtime; this module
 * only exposes stable ids + client instructions so we don't scatter model
 * strings across the app.
 */

import { geminiLiveModelId, realtimeVoiceAvailable } from "./voice";

export type RealtimeVoiceSessionInfo = {
  available: boolean;
  model: string;
  /**
   * Browser connects via our proxy (never with a raw API key). When the route
   * is live it returns an ephemeral token / WS URL — until then `available`
   * stays true only when Gemini is configured so the UI can show "coming".
   */
  proxyPath: "/api/voice/realtime";
  /** Soft budget after which the client should prefer this path over TTS. */
  preferAfterMs: number;
};

export function getRealtimeVoiceInfo(): RealtimeVoiceSessionInfo {
  return {
    available: realtimeVoiceAvailable(),
    model: geminiLiveModelId(),
    proxyPath: "/api/voice/realtime",
    preferAfterMs: Number(process.env.VOICE_LATENCY_BUDGET_MS || 1200),
  };
}
