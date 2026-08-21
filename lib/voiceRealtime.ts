/**
 * Gemini Live (realtime) capability surface — latency fallback for live Q&A.
 *
 * Production path: mint a short-lived ephemeral token server-side, then the
 * browser opens a direct WebSocket to Google (never with GEMINI_API_KEY).
 * See https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
 */

import { geminiConfigured } from "./gemini";
import {
  geminiLiveModelId,
  realtimeVoiceAvailable,
  VOICE_LATENCY_BUDGET_MS,
} from "./voice";

export type RealtimeVoiceSessionInfo = {
  available: boolean;
  model: string;
  /**
   * Browser POSTs here to mint an ephemeral token, then connects with
   * `wsUrl` + `token` (never the long-lived API key).
   */
  proxyPath: "/api/voice/realtime";
  /** Soft budget after which the client should prefer this path over TTS. */
  preferAfterMs: number;
  /** Google Live WebSocket endpoint (AI Studio / Generative Language). */
  wsUrl: string;
  /** API version required for ephemeral Live tokens. */
  apiVersion: "v1alpha";
};

const LIVE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

export function getRealtimeVoiceInfo(): RealtimeVoiceSessionInfo {
  return {
    available: realtimeVoiceAvailable(),
    model: geminiLiveModelId(),
    proxyPath: "/api/voice/realtime",
    preferAfterMs: VOICE_LATENCY_BUDGET_MS,
    wsUrl: LIVE_WS,
    apiVersion: "v1alpha",
  };
}

export type EphemeralLiveToken = {
  /** Token name (e.g. auth_tokens/…) — use as the Live API credential. */
  token: string;
  model: string;
  wsUrl: string;
  apiVersion: "v1alpha";
  expireTime?: string;
  newSessionExpireTime?: string;
  preferAfterMs: number;
};

/**
 * Mint a short-lived Live API token with the server key.
 * Constrains the session to AUDIO + our Live model so the client cannot
 * widen scope with a stolen token.
 */
export async function mintRealtimeEphemeralToken(): Promise<EphemeralLiveToken> {
  if (!geminiConfigured()) {
    throw new Error("GEMINI_API_KEY is not set — cannot mint Live tokens.");
  }
  const key = process.env.GEMINI_API_KEY!;
  const model = geminiLiveModelId();
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 2 * 60 * 1000).toISOString();

  // Ephemeral tokens are currently minted on the v1alpha AuthTokens surface.
  // The key travels in the x-goog-api-key header, never the query string —
  // query strings end up in proxy and CDN logs.
  const url = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";
  const body = {
    uses: 1,
    expireTime,
    newSessionExpireTime,
    liveConnectConstraints: {
      model: `models/${model}`,
      config: {
        responseModalities: ["AUDIO"],
      },
    },
  };

  // Bounded: a hung mint would otherwise hold the request open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new Error(
      aborted ? "Timed out minting Live ephemeral token." : "Failed to reach the Live token service."
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[voiceRealtime] mint -> ${res.status}: ${detail.slice(0, 400)}`);
    throw new Error(`Failed to mint Live ephemeral token (${res.status}).`);
  }

  const data = (await res.json()) as {
    name?: string;
    expireTime?: string;
    newSessionExpireTime?: string;
  };
  if (!data.name) {
    throw new Error("Live ephemeral token response missing name.");
  }

  return {
    token: data.name,
    model,
    wsUrl: LIVE_WS,
    apiVersion: "v1alpha",
    expireTime: data.expireTime || expireTime,
    newSessionExpireTime: data.newSessionExpireTime || newSessionExpireTime,
    preferAfterMs: VOICE_LATENCY_BUDGET_MS,
  };
}
