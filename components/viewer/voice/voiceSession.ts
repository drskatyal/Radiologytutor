// Offline voice commands, shared by the desktop viewer and the web viewer.
//
// Nothing of the recognizer exists until the reader turns the mic on: the
// recognizer code (WebAssembly, in its own worker) and the small speech model
// bundled with the app are loaded then, constrained to the fixed command
// grammar (@flowrad/viewer-core voiceCommands). Turning the mic off stops the
// microphone, closes the audio graph and terminates the worker, which frees
// the model and the recognizer entirely. No audio ever leaves the device.

import { parseVoiceCommand, voiceGrammar, type VoiceAction } from "@flowrad/viewer-core";

export type VoiceState = "off" | "loading" | "listening" | "error";

export interface VoiceSession {
  stop(): void;
}

export interface VoiceOptions {
  /** URL of the bundled model archive (same origin). */
  modelUrl: string;
  onAction: (action: VoiceAction, heard: string) => void;
  onState: (state: VoiceState, detail?: string) => void;
  /** What was heard that matched nothing (for the hint chip). */
  onUnrecognized?: (heard: string) => void;
}

// Minimal shapes of the recognizer module (loaded lazily; its types stay out of the app).
interface Recognizer {
  on(event: "result" | "partialresult", listener: (m: { result: { text?: string } }) => void): void;
  acceptWaveform(buffer: AudioBuffer): void;
  remove(): void;
}
interface RecognizerModel {
  KaldiRecognizer: new (sampleRate: number, grammar?: string) => Recognizer;
  terminate(): void;
}

/** Is the speech model part of this build? (A dev build may not have fetched it.) */
export async function voiceModelAvailable(modelUrl: string): Promise<boolean> {
  try {
    const r = await fetch(modelUrl, { method: "HEAD", cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startVoice(opts: VoiceOptions): Promise<VoiceSession> {
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
    model?.terminate();
    node = null;
    source = null;
    stream = null;
    ctx = null;
    recognizer = null;
    model = null;
    opts.onState("off");
  };

  opts.onState("loading");
  try {
    if (!(await voiceModelAvailable(opts.modelUrl))) throw new Error("Voice commands are not included in this build.");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (stopped) throw new Error("cancelled");
    const { createModel } = (await import("vosk-browser")) as unknown as { createModel: (url: string, logLevel?: number) => Promise<RecognizerModel> };
    // The worker resolves the URL itself: make it absolute.
    model = await createModel(new URL(opts.modelUrl, location.href).href, -1);
    if (stopped) throw new Error("cancelled");
    ctx = new AudioContext();
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
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const wasCancel = message === "cancelled";
    const friendly =
      e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
        ? "Microphone access was blocked. Allow it for FlowRad and try again."
        : e instanceof DOMException && e.name === "NotFoundError"
          ? "No microphone found."
          : message;
    stop();
    if (!wasCancel) opts.onState("error", friendly);
  }
  return { stop };
}
