"use client";

// Tutor answer playback. Prefers Gemini TTS (via our /api/tts route); falls
// back to the browser speechSynthesis if GEMINI_API_KEY is missing or the
// request fails. This is a vendor seam — the exported interface (speak /
// speakBeats / stopSpeaking) never changes, so swapping the TTS backend
// touches only /api/tts. Supports barge-in: stopSpeaking() cancels the
// pipeline so the student can interrupt.
//
// speakBeats pipelines sentence-sized chunks: prefetch N+1 while N plays so
// the first sentence starts as soon as its WAV is ready, and the viewer can
// drive on each beat. Live tutor answers ONLY — recorded lesson narration
// never routes through here.

let currentAudio: HTMLAudioElement | null = null;
let pipelineGen = 0;
let ttsAbort: AbortController | null = null;

export async function speak(text: string, onEnd?: () => void): Promise<void> {
  await speakBeats([text], { onEnd });
}

export async function speakBeats(
  texts: string[],
  opts?: {
    onStartBeat?: (index: number) => void;
    onEnd?: () => void;
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

  const prefetch = (t: string) => fetchTtsBlob(t, signal);

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
  signal: AbortSignal
): Promise<Blob | null> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
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
