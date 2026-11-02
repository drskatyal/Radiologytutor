// Voice e2e in the REAL app (bench only: FLOWRAD_BENCH=1 FLOWRAD_BENCH_VIEW=voice).
//
// Runs under the production CSP the installer ships with — the 0.6.4–0.8.0
// endless spinner was the recognizer failing under that CSP, which a dev
// server (no CSP) hid. The CI runner has no microphone, so the audio comes
// from a silent stream, and the spoken test phrases (FLOWRAD_BENCH_VOICE_WAV,
// read by the Rust side) are fed to the live recognizer through the session's
// test hook. Reports: time to ready, the progress it showed, any error, and
// the commands it recognised (which the app then really performed).

import type { VoiceAction } from "@flowrad/viewer-core";
import { invoke } from "./platform";

export interface VoiceBenchResult {
  state: string;
  readyMs: number | null;
  error: string | null;
  errorKind: string | null;
  progressEvents: number;
  maxLoadedBytes: number;
  heard: string[];
  actions: string[];
}

export async function runVoiceBench(perform: (a: VoiceAction) => void): Promise<VoiceBenchResult> {
  const mod = await import("@/components/viewer/voice/voiceSession");
  const result: VoiceBenchResult = { state: "off", readyMs: null, error: null, errorKind: null, progressEvents: 0, maxLoadedBytes: 0, heard: [], actions: [] };
  const started = performance.now();
  const silent = () => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createConstantSource();
    osc.offset.value = 0;
    osc.connect(dest);
    osc.start();
    return Promise.resolve(dest.stream);
  };
  const settled = new Promise<void>((resolve) => {
    void mod
      .startVoice({
        modelUrl: mod.VOICE_MODEL_URL,
        workerUrl: mod.VOICE_WORKER_URL,
        getStream: silent,
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
      .then((session) => {
        (window as Window & { __flowradVoice?: unknown }).__flowradVoice = session;
      });
  });
  // Never wait forever, whatever happens.
  await Promise.race([settled, new Promise((r) => setTimeout(r, 90_000))]);
  if (result.state !== "listening") return result;

  const session = (window as Window & { __flowradVoice?: { feed(s: Float32Array, rate: number): void; stop(): void } }).__flowradVoice;
  const wav = await invoke<ArrayBuffer>("bench_voice_wav").catch(() => new ArrayBuffer(0));
  if (session && wav.byteLength > 44) {
    const ctx = new OfflineAudioContext(1, 1, 16_000);
    const audio = await ctx.decodeAudioData(wav.slice(0));
    const pcm = audio.getChannelData(0);
    // Real-time-ish chunks so the recognizer segments utterances as it would live.
    const chunk = 4096;
    for (let at = 0; at < pcm.length; at += chunk) {
      session.feed(pcm.slice(at, at + chunk), audio.sampleRate);
      await new Promise((r) => setTimeout(r, (chunk / audio.sampleRate) * 250));
    }
    const until = performance.now() + 15_000;
    while (performance.now() < until && result.actions.length < 2) await new Promise((r) => setTimeout(r, 200));
  }
  session?.stop();
  return result;
}
