/**
 * Offline voice commands, shared by the desktop viewer and the web viewer.
 *
 * Nothing of the recognizer exists until the reader turns the mic on. Then,
 * in parallel: the microphone is requested, and the recognizer (Kaldi/Vosk
 * WebAssembly in its own worker, `recognizer-worker.js`, built by
 * scripts/build-voice-worker.mjs) downloads the small bundled model, posting
 * byte progress. The recognizer is constrained to the fixed command grammar
 * (voiceCommands.ts). Turning the mic off stops the microphone, closes the
 * audio graph and terminates the worker, which frees the model entirely. No
 * audio ever leaves the device.
 *
 * Every step can fail, and every failure ends in a state the reader can act
 * on — never an endless "loading": a missing model, a recognizer that does
 * not start, a denied or absent microphone, a permission prompt nobody
 * answers, a download that stalls. Each has its own message (voiceErrorText)
 * and the UI offers Retry.
 *
 * The worker protocol is vosk-browser's (load / create / audioChunk / remove /
 * terminate), driven directly: vosk-browser's own client only waits for a
 * "load" event, so a worker that failed hung its promise forever — the
 * 0.6.4–0.8.0 endless-spinner bug.
 */

import { parseVoiceCommand, voiceGrammar, type VoiceAction } from "./voiceCommands";

export type VoiceState = "off" | "loading" | "listening" | "error";

/** What is being waited for while loading, and how far the model download is. */
export interface VoiceProgress {
  stage: "permission" | "download" | "starting";
  /** Model bytes received (0 until the download starts). */
  loaded: number;
  /** Model size in bytes, 0 when unknown. */
  total: number;
}

export type VoiceErrorKind = "denied" | "no-mic" | "mic-busy" | "insecure" | "missing" | "load" | "timeout" | "permission-timeout";

export class VoiceError extends Error {
  constructor(
    readonly kind: VoiceErrorKind,
    message: string
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

/** One line a reader can act on, for each way voice can fail. */
export function voiceErrorText(kind: VoiceErrorKind): string {
  switch (kind) {
    case "denied":
      return "Microphone access is blocked. Allow the microphone for FlowRad (address bar or system settings) and press Retry.";
    case "no-mic":
      return "No microphone was found. Connect one and press Retry.";
    case "mic-busy":
      return "The microphone is in use by another app or could not be opened. Close it there and press Retry.";
    case "insecure":
      return "Voice commands need a secure (https) page.";
    case "missing":
      return "Voice commands are not included in this build.";
    case "load":
      return "The voice recognizer could not start. Press Retry.";
    case "timeout":
      return "Loading voice commands timed out. Check the connection and press Retry.";
    case "permission-timeout":
      return "The microphone permission was not answered. Press Retry and choose Allow.";
  }
}

/** Map a getUserMedia / load failure onto a VoiceError. */
export function toVoiceError(e: unknown): VoiceError {
  if (e instanceof VoiceError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return new VoiceError("denied", voiceErrorText("denied"));
    case "SecurityError":
      return new VoiceError(typeof isSecureContext !== "undefined" && !isSecureContext ? "insecure" : "denied", voiceErrorText(typeof isSecureContext !== "undefined" && !isSecureContext ? "insecure" : "denied"));
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return new VoiceError("no-mic", voiceErrorText("no-mic"));
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new VoiceError("mic-busy", voiceErrorText("mic-busy"));
  }
  return new VoiceError("load", voiceErrorText("load"));
}

/**
 * Resolve with the promise, or reject with `onTimeout()` after `ms`. `ms`
 * restarts every time `keepAlive` is called (a download that is still moving
 * is not timed out, one that stalls is).
 */
export function deadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): { promise: Promise<T>; keepAlive: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: (e: Error) => void = () => undefined;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fail(onTimeout()), ms);
  };
  const timeout = new Promise<never>((_, reject) => {
    fail = reject;
  });
  arm();
  const done = Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return {
    promise: done,
    keepAlive: arm,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Is the model archive really there? (A build without it answers 404, or — Tauri's SPA fallback — 200 with index.html.) */
export async function voiceModelAvailable(modelUrl: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetcher(modelUrl, { method: "HEAD", cache: "no-store" });
    if (!r.ok) return false;
    const type = r.headers.get("content-type") ?? "";
    return !/text\/html/i.test(type);
  } catch {
    return false;
  }
}

export interface VoiceTimeouts {
  /** No model bytes (or no worker answer) for this long ends the load. */
  stallMs: number;
  /** An unanswered microphone permission prompt. */
  permissionMs: number;
}

export const VOICE_TIMEOUTS: VoiceTimeouts = { stallMs: 20_000, permissionMs: 30_000 };

export interface VoiceOptions {
  /** URL of the bundled model archive (same origin). */
  modelUrl: string;
  /** URL of the recognizer worker script (same origin). */
  workerUrl: string;
  onAction: (action: VoiceAction, heard: string) => void;
  /** `detail` is the reader-facing error text when `state` is "error". */
  onState: (state: VoiceState, detail?: string, kind?: VoiceErrorKind) => void;
  onProgress?: (progress: VoiceProgress) => void;
  /** What was heard that matched nothing (for the hint chip). */
  onUnrecognized?: (heard: string) => void;
  timeouts?: Partial<VoiceTimeouts>;
  /** Test hook: where the audio comes from (default: the microphone). */
  getStream?: () => Promise<MediaStream>;
}

export interface VoiceSession {
  stop(): void;
  /**
   * Test hook: feed mono PCM (−1…1) straight to the recognizer, as if heard.
   * Resolves once the samples are queued.
   */
  feed(samples: Float32Array, sampleRate: number): void;
}

interface WorkerMessage {
  event?: string;
  result?: unknown;
  error?: string;
  loaded?: number;
  total?: number;
  recognizerId?: string;
}

const RECOGNIZER_ID = "flowrad-voice";

/** The recognizer worker loading (or holding) the model; events re-targetable. */
interface Recognizer {
  worker: Worker;
  /** Resolves once the model is loaded; rejects with a VoiceError. */
  loaded: Promise<void>;
  isLoaded(): boolean;
  progress: { loaded: number; total: number };
  sink: { progress?: () => void; result?: (text: string) => void };
  dispose(): void;
}

function spawnRecognizer(modelUrl: string, workerUrl: string): Recognizer {
  const worker = new Worker(workerUrl);
  let done = false;
  const rec: Recognizer = {
    worker,
    loaded: Promise.resolve(),
    isLoaded: () => done,
    progress: { loaded: 0, total: 0 },
    sink: {},
    dispose: () => {
      try {
        worker.postMessage({ action: "remove", recognizerId: RECOGNIZER_ID });
        worker.postMessage({ action: "terminate" });
      } catch {
        /* gone */
      }
      worker.terminate();
    },
  };
  rec.loaded = new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => {
      e.preventDefault?.();
      if (!done) reject(new VoiceError("load", voiceErrorText("load")));
    };
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data ?? {};
      if (m.event === "progress") {
        rec.progress = { loaded: m.loaded ?? 0, total: m.total ?? 0 };
        rec.sink.progress?.();
      } else if (m.event === "load") {
        if (m.result) {
          done = true;
          resolve();
        } else reject(new VoiceError("load", voiceErrorText("load")));
      } else if (m.event === "error" && !done) {
        const kind = /HTTP error/.test(String(m.error)) ? "missing" : "load";
        reject(new VoiceError(kind, voiceErrorText(kind)));
      } else if (m.event === "result") {
        const text = ((m.result as { text?: string } | undefined)?.text ?? "").trim();
        if (text) rec.sink.result?.(text);
      }
    };
  });
  rec.loaded.catch(() => undefined);
  worker.postMessage({ action: "set", key: "logLevel", value: -1 });
  // The worker resolves the URL itself: make it absolute.
  worker.postMessage({ action: "load", modelUrl: new URL(modelUrl, location.href).href });
  return rec;
}

// ── warm-up: start loading on hover / focus of the mic, so a click is ready at once ──
let warm: { key: string; rec: Recognizer; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Begin loading the recognizer and model ahead of a likely click (pointer
 * over / focus on the mic button). Idempotent. Freed again after `keepMs`
 * unless voice is switched on, so hovering costs memory only briefly.
 */
export function prewarmVoice(modelUrl: string, workerUrl: string, keepMs = 45_000): void {
  const key = `${workerUrl} ${modelUrl}`;
  if (warm?.key === key) {
    clearTimeout(warm.timer);
    warm.timer = setTimeout(dropWarm, keepMs);
    return;
  }
  dropWarm();
  try {
    const rec = spawnRecognizer(modelUrl, workerUrl);
    rec.loaded.catch(() => (warm?.rec === rec ? dropWarm() : undefined));
    warm = { key, rec, timer: setTimeout(dropWarm, keepMs) };
  } catch {
    /* no workers here: the click path reports it */
  }
}

function dropWarm(): void {
  if (!warm) return;
  clearTimeout(warm.timer);
  warm.rec.dispose();
  warm = null;
}

function takeWarm(modelUrl: string, workerUrl: string): Recognizer | null {
  if (warm?.key !== `${workerUrl} ${modelUrl}`) return null;
  const rec = warm.rec;
  clearTimeout(warm.timer);
  warm = null;
  return rec;
}

export async function startVoice(opts: VoiceOptions): Promise<VoiceSession> {
  const limits = { ...VOICE_TIMEOUTS, ...opts.timeouts };
  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let rec: Recognizer | null = null;
  let ready = false;
  const progress: VoiceProgress = { stage: "download", loaded: 0, total: 0 };
  const report = (patch: Partial<VoiceProgress>) => {
    Object.assign(progress, patch);
    opts.onProgress?.({ ...progress });
  };

  const send = (samples: Float32Array, sampleRate: number) => {
    if (!rec || !ready || stopped) return;
    // Kaldi wants int16-range floats.
    const data = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) data[i] = samples[i]! * 0x8000;
    rec.worker.postMessage({ action: "audioChunk", data, recognizerId: RECOGNIZER_ID, sampleRate }, [data.buffer]);
  };

  const teardown = () => {
    try {
      node?.disconnect();
      source?.disconnect();
    } catch {
      /* already disconnected */
    }
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    rec?.dispose();
    node = null;
    source = null;
    stream = null;
    ctx = null;
    rec = null;
    ready = false;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    teardown();
    opts.onState("off");
  };
  const session: VoiceSession = { stop, feed: send };

  opts.onState("loading");
  try {
    // ── the recognizer: a warmed one (hover), or a fresh worker + model ──
    rec = takeWarm(opts.modelUrl, opts.workerUrl);
    if (!rec) {
      if (!(await voiceModelAvailable(opts.modelUrl))) throw new VoiceError("missing", voiceErrorText("missing"));
      if (stopped) return session;
      try {
        rec = spawnRecognizer(opts.modelUrl, opts.workerUrl);
      } catch {
        throw new VoiceError("load", voiceErrorText("load"));
      }
    }
    const recognizer: Recognizer = rec;
    report(recognizer.isLoaded() ? { stage: "starting", loaded: recognizer.progress.loaded, total: recognizer.progress.total } : { stage: "download", ...recognizer.progress });
    // Byte progress, and a stall timeout that restarts while bytes arrive.
    const load = deadline(recognizer.loaded, limits.stallMs, () => new VoiceError("timeout", voiceErrorText("timeout")));
    load.promise.catch(() => undefined);
    recognizer.sink.progress = () => {
      load.keepAlive();
      if (progress.stage !== "permission") report({ stage: "download", ...recognizer.progress });
      else Object.assign(progress, recognizer.progress);
    };
    recognizer.sink.result = (text) => {
      const action = parseVoiceCommand(text);
      if (action) opts.onAction(action, text);
      else if (text !== "[unk]") opts.onUnrecognized?.(text);
    };

    // ── the microphone, in parallel: a prompt nobody answers must not hang ──
    const askMic = (opts.getStream ?? (() => {
      if (!navigator.mediaDevices?.getUserMedia) throw new VoiceError(typeof isSecureContext !== "undefined" && !isSecureContext ? "insecure" : "no-mic", voiceErrorText(typeof isSecureContext !== "undefined" && !isSecureContext ? "insecure" : "no-mic"));
      return navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }))();
    const mic = deadline(
      Promise.resolve(askMic),
      limits.permissionMs,
      () => new VoiceError("permission-timeout", voiceErrorText("permission-timeout"))
    );
    // A permission prompt that takes more than a moment: say that is what we wait for.
    const askingTimer = setTimeout(() => {
      if (!stream && !stopped) report({ stage: "permission" });
    }, 400);
    // The microphone arriving: keep it (and leave the "permission" stage).
    mic.promise.then(
      (granted) => {
        clearTimeout(askingTimer);
        if (stopped) {
          granted.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = granted;
        if (progress.stage === "permission") report(recognizer.isLoaded() ? { stage: "starting" } : { stage: "download", ...recognizer.progress });
      },
      () => clearTimeout(askingTimer)
    );
    // Both, failing fast on whichever fails first (a broken model must not
    // wait out an unanswered permission prompt, and vice versa).
    try {
      await Promise.all([mic.promise, load.promise]);
    } finally {
      mic.cancel();
      load.cancel();
    }
    if (stopped || !stream) return session;
    report({ stage: "starting" });

    ctx = new AudioContext();
    recognizer.worker.postMessage({ action: "create", recognizerId: RECOGNIZER_ID, sampleRate: ctx.sampleRate, grammar: JSON.stringify(voiceGrammar()) });
    ready = true;
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor: no extra worklet module to load (CSP-friendly); the
    // recognizer does the heavy lifting in its worker.
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (!stopped) send(e.inputBuffer.getChannelData(0), e.inputBuffer.sampleRate);
    };
    source.connect(node);
    node.connect(ctx.destination);
    opts.onState("listening");
  } catch (e) {
    const err = toVoiceError(e);
    if (!stopped) {
      stopped = true;
      teardown();
      opts.onState("error", err.message, err.kind);
    }
  }
  return session;
}
