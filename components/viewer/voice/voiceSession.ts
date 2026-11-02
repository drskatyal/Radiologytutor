// Offline voice commands, shared by the desktop viewer and the web viewer.
//
// Nothing of the recognizer exists until the reader turns the mic on: the
// recognizer code (WebAssembly, in its own worker) and the small speech model
// bundled with the app are loaded then, constrained to the fixed command
// grammar (@flowrad/viewer-core voiceCommands). Turning the mic off stops the
// microphone, closes the audio graph and terminates the worker, which frees
// the model and the recognizer entirely. No audio ever leaves the device.
//
// Loading never spins forever:
//   • `startVoice` returns its handle at once, so the mic button can cancel a
//     load in progress (it used to return only when loading had finished: a
//     load that never finished could not even be switched off);
//   • the model download reports real progress, and a download that stops
//     receiving bytes for STALL_MS is an error, not a wait;
//   • the recognizer's own `createModel` waits only for a "load" message and
//     ignores its worker's "error" (vosk-browser 0.0.8): a model it could not
//     fetch, unpack or start hung the promise for good. We listen for both,
//     plus the worker's own error event, under INIT_TIMEOUT_MS;
//   • the microphone and the model load in parallel; a permission prompt the
//     reader has not answered yet is said as such;
//   • every failure ends in `error` with a sentence the reader can act on.

import { parseVoiceCommand, voiceGrammar, type VoiceAction } from "@flowrad/viewer-core";

export type VoiceState = "off" | "loading" | "listening" | "error";

/** What the loader is doing, for a progress bar. `fraction` is null when unknown. */
export interface VoiceProgress {
  phase: "model" | "microphone" | "recognizer";
  fraction: number | null;
  label: string;
}

export interface VoiceSession {
  stop(): void;
}

export interface VoiceOptions {
  /** URL of the bundled model archive (same origin). */
  modelUrl: string;
  onAction: (action: VoiceAction, heard: string) => void;
  onState: (state: VoiceState, detail?: string) => void;
  /** Loading progress (several calls while `loading`). */
  onProgress?: (progress: VoiceProgress) => void;
  /** What was heard that matched nothing (for the hint chip). */
  onUnrecognized?: (heard: string) => void;
  /** Test seams. */
  stallMs?: number;
  initTimeoutMs?: number;
}

/** A model download that receives nothing for this long has failed. */
export const STALL_MS = 15_000;
/** Unpacking and starting the recognizer once the model is here. */
export const INIT_TIMEOUT_MS = 30_000;

// Minimal shapes of the recognizer module (loaded lazily; its types stay out of the app).
interface Recognizer {
  on(event: "result" | "partialresult", listener: (m: { result: { text?: string } }) => void): void;
  acceptWaveform(buffer: AudioBuffer): void;
  remove(): void;
}
interface RecognizerModel {
  KaldiRecognizer: new (sampleRate: number, grammar?: string) => Recognizer;
  on(event: string, listener: (m: { result?: boolean; error?: string }) => void): void;
  terminate(): void;
  worker?: Worker;
}
type VoskModule = { Model: new (url: string, logLevel?: number) => RecognizerModel };

/** Is the speech model part of this build? (A dev build may not have fetched it.) */
export async function voiceModelAvailable(modelUrl: string): Promise<boolean> {
  try {
    const r = await fetch(modelUrl, { method: "HEAD", cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

/** A failure the reader can act on. */
export function friendlyVoiceError(e: unknown): string {
  const name = e instanceof DOMException || (e && typeof e === "object" && "name" in e) ? String((e as { name: string }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
    return "Microphone access is blocked. Allow the microphone for this site (or app) and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return "No microphone found. Connect one and try again.";
  if (name === "NotReadableError" || name === "TrackStartError")
    return "The microphone is in use by another app.";
  const message = e instanceof Error ? e.message : String(e ?? "");
  return message || "Voice commands could not start.";
}

/**
 * Download the model on the page, with progress. The recognizer then reads it
 * from a blob: URL: its worker never makes a network request of its own,
 * which is what failed where worker requests do not reach the app's server
 * (the desktop app's custom protocol). Rejects on a bad status or a stall.
 */
export async function downloadModel(
  url: string,
  onProgress: (fraction: number | null, bytes: number) => void,
  signal: AbortSignal,
  stallMs: number = STALL_MS
): Promise<Blob> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("stalled")), stallMs);
  };
  try {
    arm();
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(res.status === 404 ? "Voice commands are not included in this build." : `The voice model could not be downloaded (HTTP ${res.status}).`);
    }
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body) {
      const blob = await res.blob();
      onProgress(1, blob.size);
      return blob;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      arm();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.byteLength;
      onProgress(total ? Math.min(1, bytes / total) : null, bytes);
    }
    onProgress(1, bytes);
    return new Blob(chunks as BlobPart[], { type: "application/gzip" });
  } catch (e) {
    if (signal.aborted) throw new Error("cancelled");
    if (controller.signal.aborted) throw new Error("The voice model download stopped (no data for 15 s). Check your connection and retry.");
    throw e instanceof TypeError ? new Error("The voice model could not be downloaded. Check your connection and retry.") : e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Start the recognizer on a downloaded model: resolves on its "load", rejects
 * on its "error", on its worker failing, or after `timeoutMs`.
 */
export function loadRecognizer(vosk: VoskModule, url: string, timeoutMs: number, signal: AbortSignal): Promise<RecognizerModel> {
  return new Promise((resolve, reject) => {
    let model: RecognizerModel;
    try {
      model = new vosk.Model(url, -1);
    } catch (e) {
      reject(e);
      return;
    }
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        killModel(model);
        reject(error);
      } else resolve(model);
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error("The speech recognizer did not start in time. Retry, or reload the page.")), timeoutMs);
    model.on("load", (m) => finish(m.result ? null : new Error("The speech recognizer could not load the voice model.")));
    model.on("error", (m) => finish(new Error(`The speech recognizer failed: ${m.error ?? "unknown error"}.`)));
    model.worker?.addEventListener("error", (event) => {
      event.preventDefault?.();
      finish(new Error("The speech recognizer could not start in this browser."));
    });
  });
}

/**
 * The recognizer unpacks the model into an IndexedDB-backed folder named after
 * the URL it was given, and unpacks it again on every start. With a fresh
 * blob: URL each time those copies (~40 MB each) would pile up: drop them
 * before each start. Nothing else lives there.
 */
async function clearRecognizerStore(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase("/vosk");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
    setTimeout(resolve, 2000);
  });
}

function killModel(model: RecognizerModel | null): void {
  if (!model) return;
  try {
    model.terminate();
  } catch {
    /* already gone */
  }
  // vosk-browser's terminate() only posts a message; end the worker for real
  // so the model's memory is returned at once.
  try {
    model.worker?.terminate();
  } catch {
    /* already gone */
  }
}

export async function startVoice(opts: VoiceOptions): Promise<VoiceSession> {
  const abort = new AbortController();
  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let model: RecognizerModel | null = null;
  let recognizer: Recognizer | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    try {
      node?.disconnect();
      source?.disconnect();
    } catch {
      /* already disconnected */
    }
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
    try {
      recognizer?.remove();
    } catch {
      /* worker already gone */
    }
    killModel(model);
    node = null;
    source = null;
    stream = null;
    ctx = null;
    recognizer = null;
    model = null;
    opts.onState("off");
  };

  const progress = (p: VoiceProgress) => {
    if (!stopped) opts.onProgress?.(p);
  };

  const run = async () => {
    opts.onState("loading");
    progress({ phase: "model", fraction: 0, label: "Loading voice model…" });
    const absoluteUrl = new URL(opts.modelUrl, location.href).href;

    // Microphone and model in parallel: neither waits for the other.
    let micAsked = false;
    const mic = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("No microphone found."), { name: "NotFoundError" });
      const askTimer = setTimeout(() => {
        micAsked = true;
        progress({ phase: "microphone", fraction: null, label: "Allow the microphone to use voice commands…" });
      }, 800);
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } finally {
        clearTimeout(askTimer);
      }
    })();
    // Keep a rejection from being "unhandled" while the model is still loading.
    mic.catch(() => undefined);

    const modelReady = (async () => {
      const [blob, vosk] = await Promise.all([
        downloadModel(
          absoluteUrl,
          (fraction) => {
            if (!micAsked) progress({ phase: "model", fraction, label: "Loading voice model…" });
          },
          abort.signal,
          opts.stallMs
        ),
        import("vosk-browser") as unknown as Promise<VoskModule>,
        clearRecognizerStore(),
      ]);
      if (stopped) throw new Error("cancelled");
      progress({ phase: "recognizer", fraction: null, label: "Starting the recognizer…" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        return await loadRecognizer(vosk, blobUrl, opts.initTimeoutMs ?? INIT_TIMEOUT_MS, abort.signal);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    })();
    modelReady.catch(() => undefined);

    stream = await mic;
    if (stopped) throw new Error("cancelled");
    model = await modelReady;
    if (stopped) throw new Error("cancelled");
    ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    recognizer = new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify(voiceGrammar()));
    recognizer.on("result", (m) => {
      const heard = (m.result.text ?? "").trim();
      if (!heard) return;
      const action = parseVoiceCommand(heard);
      if (action) opts.onAction(action, heard);
      else if (heard !== "[unk]") opts.onUnrecognized?.(heard);
    });
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor: no extra worklet module to load (CSP-friendly); the
    // recognizer does the heavy lifting in its worker.
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (!stopped) recognizer?.acceptWaveform(e.inputBuffer);
    };
    source.connect(node);
    node.connect(ctx.destination);
    opts.onState("listening");
  };

  void run().catch((e) => {
    const cancelled = e instanceof Error && e.message === "cancelled";
    if (stopped && cancelled) return;
    const detail = friendlyVoiceError(e);
    if (!stopped) {
      stop();
      opts.onState("error", detail);
    }
  });
  return { stop };
}
