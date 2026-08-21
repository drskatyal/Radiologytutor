/**
 * Client helper — mint a Gemini Live ephemeral token when TTS is too slow.
 * Never imports Gemini keys; only talks to our /api/voice/realtime.
 */

export type RealtimeSessionCredentials = {
  available: boolean;
  token?: string;
  model: string;
  wsUrl: string;
  apiVersion: "v1alpha";
  preferAfterMs: number;
  error?: string;
};

export async function mintRealtimeSession(): Promise<RealtimeSessionCredentials> {
  const res = await fetch("/api/voice/realtime", { method: "POST" });
  const data = (await res.json()) as {
    available?: boolean;
    token?: string;
    model?: string;
    wsUrl?: string;
    apiVersion?: "v1alpha";
    preferAfterMs?: number;
    error?: string;
  };

  if (!res.ok || !data.token) {
    return {
      available: false,
      model: data.model || "",
      wsUrl: data.wsUrl || "",
      apiVersion: "v1alpha",
      preferAfterMs: data.preferAfterMs ?? 1200,
      error: data.error || `Realtime mint failed (${res.status})`,
    };
  }

  return {
    available: true,
    token: data.token,
    model: data.model || "",
    wsUrl: data.wsUrl || "",
    apiVersion: data.apiVersion || "v1alpha",
    preferAfterMs: data.preferAfterMs ?? 1200,
  };
}
