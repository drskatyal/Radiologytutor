"use client";

// Tutor answer playback (AI teacher voice). Prefers ElevenLabs cloned teacher
// voice (via /api/tts), then Gemini TTS, then browser speechSynthesis.
// Capture tracks arm the tutor via readingDigest — they are never played here.
// See docs/CONSULTANT_READING.md.
//
// When /api/tts reports budget exceeded (slow clone/TTS), we stash a hint so
// the student session can open Gemini Live for the next conversational turn.

import { narrationHoldMs, speechAudioCanBlock, TTS_START_BUDGET_MS } from "./tutorSpeech";

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
  /** Teach-guide beats: Gemini attending voice, not the cloned mic. */
  persona?: "attending";
};

export async function speakBeats(
  texts: string[],
  opts?: {
    onStartBeat?: (index: number) => void;
    onEnd?: () => void;
    voiceId?: string | null;
    authorId?: string | null;
    persona?: "attending";
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

  const voice = {
    voiceId: opts?.persona === "attending" ? undefined : opts?.voiceId,
    authorId: opts?.persona === "attending" ? undefined : opts?.authorId,
    persona: opts?.persona,
  };
  const holds = chunks.map((chunk) => narrationHoldMs(chunk));
  // One pipeline deadline so a hung fetch cannot outlive the guide's beat cap.
  const budget = holds.reduce((sum, ms) => sum + ms, 0) + 400;

  const work = (async () => {
    for (let i = 0; i < chunks.length; i++) {
      if (gen !== pipelineGen) return;
      opts?.onStartBeat?.(i);
      const hold = holds[i] ?? narrationHoldMs(chunks[i]);
      let played = false;
      try {
        const blob = await fetchTtsBlob(
          chunks[i],
          signal,
          voice,
          Math.min(hold, Math.max(TTS_START_BUDGET_MS, 4_000))
        );
        if (gen !== pipelineGen) return;
        if (blob && speechAudioCanBlock(blob.size, null)) {
          const result = await playBlob(blob, () => gen !== pipelineGen, hold);
          played = result === "played";
        }
      } catch {
        played = false;
      }
      if (gen !== pipelineGen) return;
      if (!played) {
        await fallbackSpeakAsync(
          chunks[i],
          () => gen !== pipelineGen,
          Math.min(hold, 6_000)
        );
      }
    }
  })();

  await new Promise<void>((resolve) => {
    let settled = false;
    let timer = 0;
    const settle = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(() => {
      // onEnd while this generation is still current, then retire the audio
      // so a late blob cannot speak over the next beat.
      finish();
      if (pipelineGen === gen) stopSpeaking();
      settle();
    }, budget);
    work.then(
      () => {
        finish();
        settle();
      },
      () => {
        finish();
        settle();
      }
    );
  });
}

async function fetchTtsBlob(
  text: string,
  signal: AbortSignal,
  voice?: { voiceId?: string | null; authorId?: string | null; persona?: "attending" },
  timeoutMs = TTS_START_BUDGET_MS
): Promise<Blob | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(250, timeoutMs));
  const onParentAbort = () => timeout.abort();
  if (signal.aborted) timeout.abort();
  else signal.addEventListener("abort", onParentAbort);
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        // voiceId is intentionally not sent — /api/tts resolves the voice from
        // the author record server-side so a client cannot pick an arbitrary one.
        authorId: voice?.persona === "attending" ? undefined : voice?.authorId || undefined,
        persona: voice?.persona,
      }),
      signal: timeout.signal,
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
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParentAbort);
  }
}

/** How long to wait for audio to start before falling through to speechSynthesis. */
const AUDIO_START_MS = TTS_START_BUDGET_MS;

function playBlob(
  blob: Blob,
  cancelled: () => boolean,
  maxMs: number
): Promise<"played" | "unplayed"> {
  return new Promise((resolve) => {
    if (cancelled() || maxMs <= 0 || !speechAudioCanBlock(blob.size, null)) {
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
    const cap = Math.max(250, maxMs);
    timer = window.setTimeout(
      () => finish(started ? "played" : "unplayed"),
      Math.min(AUDIO_START_MS, cap)
    );
    const arm = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => finish(started ? "played" : "unplayed"), ms);
    };
    audio.onplaying = () => {
      started = true;
      const durMs = Number.isFinite(audio.duration) ? audio.duration * 1000 + 500 : cap;
      arm(Math.min(cap, Math.max(800, durMs)));
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
  cancelled: () => boolean,
  maxMs: number
): Promise<void> {
  return new Promise((resolve) => {
    if (cancelled() || maxMs <= 0 || !window.speechSynthesis) {
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
    timer = window.setTimeout(done, Math.max(250, maxMs));
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
