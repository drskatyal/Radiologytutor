"use client";

/**
 * Browser Gemini Live client.
 *
 * Mint stays on POST /api/voice/realtime (session required, key stays on the
 * server). This socket streams mic PCM up and plays PCM audio back. Tool
 * calls are handed to the viewer and answered without blocking playback.
 */

import type { LiveToolDeclaration } from "./liveTeachingPack";
import { mintRealtimeSession } from "./voiceRealtimeClient";
import {
  buildLiveAudioInput,
  buildLiveSetup,
  buildLiveTextInput,
  buildLiveToolResponse,
  downsampleToPcm16,
  liveWebSocketUrl,
  parseLiveServerMessage,
  pcm16ToBase64,
  type LiveServerEvent,
  type LiveSource,
  type LiveToolCall,
} from "./geminiLiveProtocol";

export type LiveSessionPhase = "connecting" | "listening" | "speaking";

export type LiveToolResult = {
  id?: string;
  name: string;
  response: Record<string, unknown>;
};

export type GeminiLiveHandlers = {
  onPhase: (phase: LiveSessionPhase) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onSources: (sources: LiveSource[]) => void;
  onToolCalls: (calls: LiveToolCall[]) => Promise<LiveToolResult[]>;
  onLevel: (level: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
};

type ScriptProcessor = ScriptProcessorNode;

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private stopped = false;
  private ready = false;
  private closeNotified = false;
  private stream: MediaStream | null = null;
  private capture: AudioContext | null = null;
  private playback: AudioContext | null = null;
  private processor: ScriptProcessor | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private nextPlayAt = 0;
  private openingText = "";
  private model = "gemini-3.8-live";

  constructor(private handlers: GeminiLiveHandlers) {}

  get isOpen(): boolean {
    return this.ready && !this.stopped && this.ws?.readyState === WebSocket.OPEN;
  }

  async start(input: {
    systemInstruction: string;
    tools: readonly LiveToolDeclaration[];
    openingText: string;
  }): Promise<void> {
    this.openingText = input.openingText.trim();
    this.handlers.onPhase("connecting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      this.fail("Microphone blocked. Allow mic access to start the session.");
      return;
    }
    if (this.stopped) {
      this.stopTracks();
      return;
    }

    const creds = await mintRealtimeSession();
    if (this.stopped) {
      this.stopTracks();
      return;
    }
    if (!creds.available || !creds.token || !creds.wsUrl) {
      this.fail(creds.error || "Gemini Live is unavailable.");
      return;
    }
    this.model = creds.model || this.model;

    const ws = new WebSocket(liveWebSocketUrl(creds.wsUrl, creds.token));
    this.ws = ws;
    ws.onopen = () => {
      if (this.stopped) {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify(
          buildLiveSetup({
            model: this.model,
            systemInstruction: input.systemInstruction,
            tools: input.tools,
          })
        )
      );
    };
    ws.onmessage = (event) => {
      void this.onMessage(event);
    };
    ws.onerror = () => {
      if (!this.stopped) this.handlers.onError("The live session connection failed.");
    };
    ws.onclose = () => {
      this.ready = false;
      this.notifyClose();
    };

    await this.startCapture();
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.isOpen || !this.ws) return;
    this.ws.send(buildLiveTextInput(trimmed));
  }

  /**
   * Replace the system instruction and the full tool list. Used when the
   * learner changes mode or the current finding. Gemini 3.8 Live only.
   */
  sendContextUpdate(message: string): void {
    if (!this.isOpen || !this.ws || !message) return;
    this.ws.send(message);
  }

  /** Drop queued tutor audio. The mic stays open. */
  interruptPlayback(): void {
    this.stopPlayback();
    this.handlers.onInterrupted();
  }

  hangup(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.stopPlayback();
    this.stopCapture();
    this.stopTracks();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.notifyClose();
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }

  private fail(message: string): void {
    this.handlers.onError(message);
    this.hangup();
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const raw = await messageText(event.data);
    if (!raw || this.stopped) return;
    let events: LiveServerEvent[] = [];
    try {
      events = parseLiveServerMessage(raw);
    } catch {
      return;
    }
    for (const item of events) {
      if (this.stopped) return;
      if (item.type === "setupComplete") {
        this.ready = true;
        this.handlers.onPhase("listening");
        if (this.openingText) this.sendText(this.openingText);
        continue;
      }
      if (item.type === "audio") {
        this.handlers.onPhase("speaking");
        this.playPcm(item.base64, item.sampleRate);
        continue;
      }
      if (item.type === "inputTranscript") this.handlers.onInputTranscript(item.text);
      else if (item.type === "outputTranscript") {
        this.handlers.onPhase("speaking");
        this.handlers.onOutputTranscript(item.text);
      } else if (item.type === "sources") this.handlers.onSources(item.sources);
      else if (item.type === "interrupted") this.interruptPlayback();
      else if (item.type === "turnComplete") {
        this.handlers.onTurnComplete();
        if (!this.stopped) this.handlers.onPhase("listening");
      } else if (item.type === "error") this.handlers.onError(item.message);
      else if (item.type === "toolCall") {
        const calls = item.calls;
        void this.handlers
          .onToolCalls(calls)
          .then((results) => {
            if (!this.isOpen || !this.ws) return;
            this.ws.send(buildLiveToolResponse(results));
          })
          .catch(() => {
            if (!this.isOpen || !this.ws) return;
            this.ws.send(
              buildLiveToolResponse(
                calls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  response: { error: "The viewer could not run that tool." },
                }))
              )
            );
          });
      }
    }
  }

  private async startCapture(): Promise<void> {
    if (!this.stream || this.stopped) return;
    const capture = new AudioContext();
    this.capture = capture;
    await capture.resume();
    const source = capture.createMediaStreamSource(this.stream);
    const processor = capture.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    const mute = capture.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!this.ready || this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const channel = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < channel.length; i++) sum += Math.abs(channel[i] ?? 0);
      this.handlers.onLevel(Math.min(1, (sum / channel.length) * 4));
      const pcm = downsampleToPcm16(channel, capture.sampleRate, 16000);
      if (pcm.length === 0) return;
      this.ws.send(buildLiveAudioInput(pcm16ToBase64(pcm)));
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(capture.destination);
  }

  private playPcm(base64: string, sampleRate: number): void {
    if (this.stopped) return;
    if (!this.playback) this.playback = new AudioContext();
    const ctx = this.playback;
    void ctx.resume();
    const bytes = base64ToBytes(base64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount <= 0) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    const floats = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) floats[i] = view.getInt16(i * 2, true) / 0x8000;
    const buffer = ctx.createBuffer(1, floats.length, sampleRate);
    buffer.copyToChannel(floats, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.02, this.nextPlayAt);
    node.start(start);
    this.nextPlayAt = start + buffer.duration;
    this.sources.push(node);
    node.onended = () => {
      this.sources = this.sources.filter((item) => item !== node);
    };
  }

  private stopPlayback(): void {
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.nextPlayAt = 0;
  }

  private stopCapture(): void {
    try {
      this.processor?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.processor = null;
    void this.capture?.close();
    this.capture = null;
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.playback?.close();
    this.playback = null;
  }
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return "";
}

function base64ToBytes(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
