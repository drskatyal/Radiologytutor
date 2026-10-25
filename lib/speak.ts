"use client";

// Tutor answer playback (AI teacher voice). Prefers ElevenLabs cloned teacher
// voice (via /api/tts), then Gemini TTS, then browser speechSynthesis.
// Capture tracks arm the tutor via readingDigest — they are never played here.
// See docs/CONSULTANT_READING.md.
//
// When /api/tts reports budget exceeded (slow clone/TTS), we stash a hint so
// the student session can open Gemini Live for the next conversational turn.

import { speechAudioCanBlock } from "./tutorSpeech";

let currentAudio: HTMLAudioElement | null = null;
let pipelineGen = 0;
let ttsAbort: AbortController | null = null;

/** Soft hint from the last TTS response — prefer Gemini Live next turn. */
let preferRealtimeNext = false;
let lastTtsLatencyMs: number | null = null;

export function shouldPreferRealtimeVoice(): boolean {
  return preferRealtimeNext;
}

export function lastTutorTtsLatencyMs(): number | null {
  return lastTtsLatencyMs;
}

export function clearRealtimeVoiceHint(): void {
  preferRealtimeNext = false;
}

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
  let ended = false;
  const finish = () => {
    if (ended || gen !== pipelineGen) return;
    ended = true;
    opts?.onEnd?.();
  };

  const prefetch = (t: string) =>
    fetchTtsBlob(t, signal, {
      voiceId: opts?.voiceId,
      authorId: opts?.authorId,
    });

  let nextBlob = prefetch(chunks[0]);

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (gen !== pipelineGen) return;
      opts?.onStartBeat?.(i);
      const blobP = nextBlob;
      if (i + 1 < chunks.length) nextBlob = prefetch(chunks[i + 1]);

      let played = false;
      try {
        const blob = await blobP;
        if (gen !== pipelineGen) return;
        if (blob && speechAudioCanBlock(blob.size, null)) {
          const result = await playBlob(blob, () => gen !== pipelineGen);
          played = result === "played";
        }
      } catch {
        played = false;
      }
      if (gen !== pipelineGen) return;
      if (!played) await fallbackSpeakAsync(chunks[i], () => gen !== pipelineGen);
    }
    finish();
  } catch {
    finish();
  }
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
        // voiceId is intentionally not sent — /api/tts resolves the voice from
        // the author record server-side so a client cannot pick an arbitrary one.
        authorId: voice?.authorId || undefined,
      }),
      signal,
    });
    if (!res.ok) return null;

    const latencyHdr = res.headers.get("X-FlowRad-Voice-Latency-Ms");
    if (latencyHdr) {
      const n = Number(latencyHdr);
      if (Number.isFinite(n)) lastTtsLatencyMs = n;
    }
    if (res.headers.get("X-FlowRad-Voice-Budget-Exceeded") === "1") {
      preferRealtimeNext = true;
    }

    return await res.blob();
  } catch {
    return null;
  }
}

/** How long to wait for audio to start before falling through to speechSynthesis. */
const AUDIO_START_MS = 8_000;
/** Cap so a clip that never fires `ended` cannot stall the tour. */
const AUDIO_MAX_MS = 60_000;

function playBlob(blob: Blob, cancelled: () => boolean): Promise<"played" | "unplayed"> {
  return new Promise((resolve) => {
    if (cancelled() || !speechAudioCanBlock(blob.size, null)) {
      resolve(cancelled() ? "played" : "unplayed");
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    let settled = false;
    let started = false;
    let timer = 0;
    const finish = (result: "played" | "unplayed") => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.pause();
      URL.revokeObjectURL(url);
      audio.onended = null;
      audio.onerror = null;
      if (currentAudio === audio) currentAudio = null;
      resolve(result);
    };
    timer = window.setTimeout(() => finish(started ? "played" : "unplayed"), AUDIO_START_MS);
    const arm = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => finish(started ? "played" : "unplayed"), ms);
    };
    audio.onplaying = () => {
      started = true;
      arm(AUDIO_MAX_MS);
    };
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : null;
      if (!speechAudioCanBlock(blob.size, duration)) finish("unplayed");
    };
    audio.onended = () => finish("played");
    audio.onerror = () => finish("unplayed");
    audio.play().catch(() => finish("unplayed"));
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
    let settled = false;
    let timer = 0;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    // speechSynthesis sometimes never fires onend; don't hold the tour.
    timer = window.setTimeout(done, Math.min(AUDIO_MAX_MS, Math.max(4_000, text.length * 90)));
    utter.onend = done;
    utter.onerror = done;
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
