/**
 * ElevenLabs provider — Instant Voice Clone + TTS.
 * Import ONLY from lib/voice.ts (vendor seam).
 */

export type ElevenLabsSpeech = {
  audio: Buffer;
  mimeType: "audio/mpeg";
  provider: "elevenlabs";
};

export function elevenLabsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

const API_BASE = "https://api.elevenlabs.io/v1";

function requireKey(): string {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set.");
  return key;
}

/** Default multilingual model — override with ELEVENLABS_TTS_MODEL. */
function ttsModel(): string {
  return process.env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_multilingual_v2";
}

/**
 * Synthesize speech with a cloned (or library) voice id.
 * Returns mpeg bytes the browser can play directly.
 */
export async function elevenLabsSynthesize(
  text: string,
  voiceId: string
): Promise<ElevenLabsSpeech> {
  const key = requireKey();
  const vid = voiceId.trim();
  if (!vid) throw new Error("voiceId is required for ElevenLabs TTS.");

  const res = await fetch(`${API_BASE}/text-to-speech/${encodeURIComponent(vid)}`, {
    method: "POST",
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: text.trim(),
      model_id: ttsModel(),
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.15,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${errText}`);
  }
  const ab = await res.arrayBuffer();
  return { audio: Buffer.from(ab), mimeType: "audio/mpeg", provider: "elevenlabs" };
}

/**
 * Instant voice clone from sample audio buffers (teacher enrollment).
 * Samples should be clean teaching narration (wav/mp3/webm), ≥ ~30s total.
 */
export async function elevenLabsCloneVoice(opts: {
  name: string;
  description?: string;
  samples: Array<{ bytes: Buffer; filename: string; mimeType: string }>;
}): Promise<{ voiceId: string }> {
  const key = requireKey();
  if (opts.samples.length === 0) {
    throw new Error("At least one audio sample is required to clone a voice.");
  }

  const form = new FormData();
  form.append("name", opts.name);
  if (opts.description) form.append("description", opts.description);
  form.append(
    "labels",
    JSON.stringify({ product: "flowrad-learn", use: "radiology-tutor" })
  );
  for (const s of opts.samples) {
    const blob = new Blob([new Uint8Array(s.bytes)], { type: s.mimeType });
    form.append("files", blob, s.filename);
  }

  const res = await fetch(`${API_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs clone error ${res.status}: ${errText}`);
  }
  const data = (await res.json()) as { voice_id?: string };
  if (!data.voice_id) throw new Error("ElevenLabs clone returned no voice_id.");
  return { voiceId: data.voice_id };
}
