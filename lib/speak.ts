"use client";

// Tutor answer playback. Prefers ElevenLabs cloned teacher voice (via /api/tts),
// then Gemini TTS, then browser speechSynthesis. Vendor seam: speak / speakBeats /
// stopSpeaking never change — only /api/tts + lib/voice.ts do.
// Recorded lesson narration NEVER routes through here (plays Finding.track.audioUrl).
// See docs/CONSULTANT_READING.md.

let currentAudio: HTMLAudioElement | null = null;
let pipelineGen = 0;
let ttsAbort: AbortController | null = null;

export async function speak(
  text: string,
  onEnd?: () => void,
  opts?: SpeakOpts
): Promise<void> {
  await speakBeats([text], { onEnd, ...opts });
}

export type SpeakOpts = {
  /** ElevenLabs voice id for the case author (cloned tutor). */
  voiceId?: string | null;
  /** Resolve voice from Author.voice when voiceId not known client-side. */
  authorId?: string | null;
};

export async function speakBeats(
  texts: string[],
  opts?: {
    onStartBeat?: (index: number) => void;
    onEnd?: () => void;
    voiceId?: string | null;
    authorId?: string | null;
  }
): Promise<void> {
  const chunks = texts.map((t) => t.trim()).filter(Boolean);
  if (typeof window === "undefined" || chunks.length === 0) {
    opts?.onEnd?.();
    return;
  }

  stopSpeaking();
  const gen = pipelineGen;
  ttsAbort = new AbortController();
  const signal = ttsAbort.signal;

  const prefetch = (t: string) =>
    fetchTtsBlob(t, signal, {
      voiceId: opts?.voiceId,
      authorId: opts?.authorId,
    });

  let nextBlob = prefetch(chunks[0]);

  for (let i = 0; i < chunks.length; i++) {
    if (gen !== pipelineGen) return;
    opts?.onStartBeat?.(i);
    const blobP = nextBlob;
    if (i + 1 < chunks.length) nextBlob = prefetch(chunks[i + 1]);

    try {
      const blob = await blobP;
      if (gen !== pipelineGen) return;
      if (blob) {
        await playBlob(blob, () => gen !== pipelineGen);
      } else {
        await fallbackSpeakAsync(chunks[i], () => gen !== pipelineGen);
      }
    } catch {
      if (gen !== pipelineGen) return;
      await fallbackSpeakAsync(chunks[i], () => gen !== pipelineGen);
    }
  }

  if (gen === pipelineGen) opts?.onEnd?.();
}

async function fetchTtsBlob(
  text: string,
  signal: AbortSignal,
  voice?: { voiceId?: string | null; authorId?: string | null }
): Promise<Blob | null> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voiceId: voice?.voiceId || undefined,
        authorId: voice?.authorId || undefined,
      }),
      signal,
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

function playBlob(blob: Blob, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (cancelled()) {
      resolve();
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    const done = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

function fallbackSpeakAsync(
  text: string,
  cancelled: () => boolean
): Promise<void> {
  return new Promise((resolve) => {
    if (cancelled() || !window.speechSynthesis) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.lang = "en-US";
    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

export function stopSpeaking(): void {
  pipelineGen += 1;
  ttsAbort?.abort();
  ttsAbort = null;
  if (typeof window === "undefined") return;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}
