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
/** Tears down the clip in playBlob. stopSpeaking calls it instead of poking src. */
let releaseAudio: (() => void) | null = null;
/**
 * Next attending line, fetched while the current clip plays. Not the active
 * playback abort: starting a line must not cancel the fetch already in flight
 * for the line after it. Interrupt (stopSpeaking) drops it so a stale
 * "Follow the stack." cannot land on the next finding.
 */
let primed: { key: string; abort: AbortController; blob: Promise<Blob | null> } | null = null;
/**
 * True after we hand a line to speechSynthesis. Chrome often leaves
 * `speaking` and `pending` false until a later task, so stopSpeaking
 * cannot trust those flags — a queued "Follow the stack." would start
 * after the finding had already changed.
 */
let synthArmed = false;

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

function primeKey(text: string, persona?: SpeakOpts["persona"]): string {
  return `${persona ?? "tutor"}:${text.trim()}`;
}

/**
 * Start the attending TTS fetch for a line that is not playing yet.
 * Safe to call while another clip is speaking: this does not stop audio.
 * A second prime for a different line replaces the first. The same line
 * keeps the fetch already in flight.
 */
export function primeAttendingSpeech(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || typeof window === "undefined") return;
  const key = primeKey(trimmed, "attending");
  if (primed?.key === key) return;
  primed?.abort.abort();
  const abort = new AbortController();
  const hold = narrationHoldMs(trimmed);
  primed = {
    key,
    abort,
    blob: fetchTtsBlob(
      trimmed,
      abort.signal,
      { persona: "attending" },
      Math.min(hold, Math.max(TTS_START_BUDGET_MS, 4_000))
    ),
  };
}

function takePrimed(text: string, persona?: SpeakOpts["persona"]): Promise<Blob | null> | null {
  const key = primeKey(text, persona);
  if (!primed || primed.key !== key) return null;
  const blob = primed.blob;
  primed = null;
  return blob;
}

function dropPrimed(): void {
  primed?.abort.abort();
  primed = null;
}

/** Stop the clip that is playing. Does not drop a primed next line. */
function haltPlayback(): void {
  pipelineGen += 1;
  ttsAbort?.abort();
  ttsAbort = null;
  const release = releaseAudio;
  releaseAudio = null;
  release?.();
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (synth && (synthArmed || synth.speaking || synth.pending)) {
    synthArmed = false;
    try {
      synth.cancel();
    } catch {
      /* already idle */
    }
  }
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

  // Take a primed fetch before halting. haltPlayback bumps the generation
  // and aborts the clip that is finishing; it must not abort the blob this
  // call is about to play. The fetch for chunks[1] starts inside the loop,
  // overlapped with playback of chunks[0].
  const primedFirst = takePrimed(chunks[0] ?? "", opts?.persona);
  haltPlayback();
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

  const fetchChunk = (text: string, hold: number) =>
    fetchTtsBlob(text, signal, voice, Math.min(hold, Math.max(TTS_START_BUDGET_MS, 4_000)));

  const work = (async () => {
    // Sentence 0 may already be in flight (primed while the previous line
    // played). Sentence i+1 is issued before we wait out sentence i, so the
    // next clip is fetched while this one is still speaking.
    let upcoming: Promise<Blob | null> | null = primedFirst;
    for (let i = 0; i < chunks.length; i++) {
      if (gen !== pipelineGen) return;
      const hold = holds[i] ?? narrationHoldMs(chunks[i]);
      const currentFetch = upcoming ?? fetchChunk(chunks[i], hold);
      upcoming = null;
      if (i + 1 < chunks.length) {
        const nextHold = holds[i + 1] ?? narrationHoldMs(chunks[i + 1]);
        upcoming = fetchChunk(chunks[i + 1], nextHold);
      }
      // Tools and the on-image caption move with this sentence. They do not
      // wait for the fetch when the blob was primed, and they do not wait
      // for the previous sentence's clip — that clip has already ended.
      opts?.onStartBeat?.(i);
      let played = false;
      try {
        const blob = await currentFetch;
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
    let killed = false;
    let timer = 0;
    // Assigned below. finish only runs after that, from a timer or stopSpeaking.
    let release: () => void = () => {};
    const silence = () => {
      try {
        audio.pause();
        // Detach the blob before revoking it. Assigning src="" is a failed
        // media load, which Chrome prints even when onerror is handled.
        audio.removeAttribute("src");
        audio.load();
      } catch {
        /* element already gone */
      }
    };
    const finish = (result: "played" | "unplayed") => {
      if (settled) {
        // play() can resolve after pause and start the element again.
        if (killed || cancelled()) silence();
        return;
      }
      settled = true;
      killed = true;
      if (releaseAudio === release) releaseAudio = null;
      window.clearTimeout(timer);
      // Drop handlers before pause/revoke. Clearing src, or revoking a blob
      // the element is still fetching, is a media error Chrome logs in red.
      audio.onended = null;
      audio.onerror = null;
      audio.onplaying = null;
      audio.onloadedmetadata = null;
      silence();
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve(result);
    };
    release = () => finish(started ? "played" : "unplayed");
    releaseAudio = release;
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
      if (killed || cancelled()) {
        silence();
        if (!settled) finish(started ? "played" : "unplayed");
        return;
      }
      started = true;
      const durMs = Number.isFinite(audio.duration) ? audio.duration * 1000 + 500 : cap;
      arm(Math.min(cap, Math.max(800, durMs)));
    };
    audio.onloadedmetadata = () => {
      if (killed || cancelled()) return;
      const duration = Number.isFinite(audio.duration) ? audio.duration : null;
      if (!speechAudioCanBlock(blob.size, duration)) finish("unplayed");
    };
    audio.onended = () => finish("played");
    audio.onerror = () => finish("unplayed");
    // play() is async. pause() before it starts does not stick — the
    // element begins after stopSpeaking unless we silence that resolution.
    audio
      .play()
      .then(() => {
        if (killed || cancelled()) silence();
      })
      .catch(() => {
        if (!settled) finish("unplayed");
      });
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
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending || synthArmed) {
      synthArmed = false;
      try {
        synth.cancel();
      } catch {
        /* empty queue */
      }
    }
    if (cancelled()) {
      resolve();
      return;
    }
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
    utter.onstart = () => {
      if (!cancelled()) return;
      synthArmed = false;
      try {
        synth.cancel();
      } catch {
        /* already stopped */
      }
      done();
    };
    // Re-check immediately before queueing. stopSpeaking during the
    // utterance constructor must not leave this line to start later.
    if (cancelled()) {
      done();
      return;
    }
    synthArmed = true;
    try {
      synth.speak(utter);
    } catch {
      synthArmed = false;
      done();
    }
  });
}

export function stopSpeaking(): void {
  haltPlayback();
  // A primed next line is the line we are no longer going to say.
  dropPrimed();
}
