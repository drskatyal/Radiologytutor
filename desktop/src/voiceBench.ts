// Voice e2e in the REAL app (bench only: FLOWRAD_BENCH=1 FLOWRAD_BENCH_VIEW=voice).
//
// Runs under the production CSP the installer ships with — the 0.6.4–0.8.0
// endless spinner was the recognizer failing under that CSP, which a dev
// server (no CSP) hid. The CI runner has no microphone, so the session's
// audio input is a MediaStream that plays the spoken test phrases
// (FLOWRAD_BENCH_VOICE_WAV, read by the Rust side) once voice is listening:
// the same audio path a microphone takes (stream → audio graph → recognizer
// worker). Reports time to ready, the progress shown, any error, and the
// commands recognised (which the app then really performs).

import type { VoiceAction } from "@flowrad/viewer-core";
import { invoke } from "./platform";

export interface VoiceBenchResult {
  state: string;
  readyMs: number | null;
  error: string | null;
  errorKind: string | null;
  progressEvents: number;
  maxLoadedBytes: number;
  wavBytes: number;
  playedSeconds: number;
  heard: string[];
  actions: string[];
}

export async function runVoiceBench(perform: (a: VoiceAction) => void): Promise<VoiceBenchResult> {
  const mod = await import("@/components/viewer/voice/voiceSession");
  const result: VoiceBenchResult = {
    state: "off",
    readyMs: null,
    error: null,
    errorKind: null,
    progressEvents: 0,
    maxLoadedBytes: 0,
    wavBytes: 0,
    playedSeconds: 0,
    heard: [],
    actions: [],
  };
  // The "microphone": silence until the phrases are played into it.
  const audio = new AudioContext();
  const dest = audio.createMediaStreamDestination();
  const wav = await invoke<ArrayBuffer>("bench_voice_wav").catch(() => new ArrayBuffer(0));
  result.wavBytes = wav.byteLength;
  const phrases = wav.byteLength > 44 ? await audio.decodeAudioData(wav.slice(0)).catch(() => null) : null;

  const started = performance.now();
  let session: { stop(): void } | null = null;
  const settled = new Promise<void>((resolve) => {
    void mod
      .startVoice({
        modelUrl: mod.VOICE_MODEL_URL,
        workerUrl: mod.VOICE_WORKER_URL,
        getStream: () => Promise.resolve(dest.stream),
        onProgress: (p) => {
          result.progressEvents += 1;
          result.maxLoadedBytes = Math.max(result.maxLoadedBytes, p.loaded);
        },
        onAction: (action, heard) => {
          result.heard.push(heard);
          result.actions.push(action.type);
          perform(action);
        },
        onUnrecognized: (heard) => result.heard.push(`${heard} ?`),
        onState: (state, detail, kind) => {
          result.state = state;
          if (state === "listening") {
            result.readyMs = Math.round(performance.now() - started);
            resolve();
          }
          if (state === "error") {
            result.error = detail ?? null;
            result.errorKind = kind ?? null;
            resolve();
          }
        },
      })
      .then((s) => {
        session = s;
      });
  });
  // Never wait forever, whatever happens.
  await Promise.race([settled, new Promise((r) => setTimeout(r, 90_000))]);

  if (result.state === "listening" && phrases) {
    const play = audio.createBufferSource();
    play.buffer = phrases;
    play.connect(dest);
    await audio.resume().catch(() => undefined);
    play.start();
    result.playedSeconds = Math.round(phrases.duration * 10) / 10;
    // The phrases, then a few seconds of silence for the last one to end.
    const until = performance.now() + phrases.duration * 1000 + 8_000;
    while (performance.now() < until && result.actions.length < 3) await new Promise((r) => setTimeout(r, 200));
  }
  (session as { stop(): void } | null)?.stop();
  void audio.close().catch(() => undefined);
  return result;
}
