/**
 * Gemini Live session contract for the learner.
 *
 * Opening the microphone starts the session. Scrolling the study does not.
 * Setup targets gemini-3.8-live: no thinking_level, audio out, async tools
 * (behavior NON_BLOCKING). The system instruction is speakable prose.
 * Drive anchors travel only through tool results. Mid-session finding and
 * mode changes use contextUpdate and send the full tool list again.
 *
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
 * https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 */

import {
  liveModeFromSession,
  livePackInstruction,
  livePackTools,
  liveSessionKick as packKick,
  type LiveMode,
  type LiveTeachingPack,
  type LiveToolDeclaration,
} from "./liveTeachingPack";

/** Constrained Live socket. Ephemeral tokens are access_token, never the API key. */
export const GEMINI_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export type LiveTeachMode = LiveMode;

export { liveModeFromSession };

export type LiveToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

export type LiveSource = { title: string; url: string };

export type LiveServerEvent =
  | { type: "setupComplete" }
  | { type: "audio"; base64: string; sampleRate: number }
  | { type: "inputTranscript"; text: string }
  | { type: "outputTranscript"; text: string }
  | { type: "toolCall"; calls: LiveToolCall[] }
  | { type: "interrupted" }
  | { type: "turnComplete" }
  | { type: "sources"; sources: LiveSource[] }
  | { type: "error"; message: string };

/** System instruction for a Live session. The pack is the only teaching source. */
export function liveSessionInstruction(input: {
  pack: LiveTeachingPack;
  mode: LiveTeachMode;
  caseTitle?: string;
  focusFindingId?: string;
}): string {
  const mode: LiveMode = input.mode === "examiner" ? "examiner" : "teach_me";
  return livePackInstruction(input.pack, mode, input.caseTitle, input.focusFindingId);
}

/** Hidden first turn when the mic opens with nothing typed. Not shown as a chat bubble. */
export function liveSessionKick(mode: LiveTeachMode): string {
  return packKick(mode === "examiner" ? "examiner" : "teach_me");
}

export function liveModelResource(model: string): string {
  const id = model.trim();
  return id.startsWith("models/") ? id : `models/${id}`;
}

/** Fields locked into the ephemeral token. No thinking config — 3.8 Live rejects it. */
export function liveMintConstraints(model: string): {
  model: string;
  config: { responseModalities: ["AUDIO"] };
} {
  return {
    model: liveModelResource(model),
    config: { responseModalities: ["AUDIO"] },
  };
}

function stripThinking(record: Record<string, unknown>): void {
  delete record.thinking_level;
  delete record.thinkingLevel;
  delete record.thinking_config;
  delete record.thinkingConfig;
  delete record.proactive_audio;
  delete record.proactiveAudio;
  delete record.enable_affective_dialog;
  delete record.enableAffectiveDialog;
}

/**
 * Live is mic audio and speakable text. A viewport recording is a Process-time
 * compile input and must not ride along in setup, even if a caller stuffed
 * inline video into `extra`.
 */
function stripLiveMedia(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripLiveMedia).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const mime = record.mimeType ?? record.mime_type;
  if (typeof mime === "string" && mime.toLowerCase().startsWith("video/")) return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "inlineData" || key === "inline_data" || key === "fileData" || key === "file_data" || key === "video") {
      continue;
    }
    const cleaned = stripLiveMedia(item);
    if (cleaned !== undefined) next[key] = cleaned;
  }
  return next;
}

/** Pack tools for Live, including set_series and web_search. Async calls are explicit. */
export function liveFunctionDeclarations(
  tools: readonly LiveToolDeclaration[] = livePackTools([])
): Array<LiveToolDeclaration & { behavior: "NON_BLOCKING" }> {
  return tools.map((tool) => {
    const next = { ...tool } as LiveToolDeclaration & { behavior?: string };
    delete next.behavior;
    return { ...next, behavior: "NON_BLOCKING" };
  });
}

/**
 * First WebSocket message. Drops thinking_level / affective dialog even if a
 * caller stuffed them into `extra`.
 */
export function buildLiveSetup(input: {
  model: string;
  systemInstruction: string;
  tools?: readonly LiveToolDeclaration[];
  extra?: Record<string, unknown>;
}): { setup: Record<string, unknown> } {
  const extra = stripLiveMedia({ ...(input.extra ?? {}) }) as Record<string, unknown>;
  stripThinking(extra);
  const generation =
    extra.generationConfig && typeof extra.generationConfig === "object"
      ? { ...(extra.generationConfig as Record<string, unknown>) }
      : undefined;
  if (generation) {
    stripThinking(generation);
    extra.generationConfig = generation;
  }
  const setup: Record<string, unknown> = {
    ...extra,
    model: liveModelResource(input.model),
    responseModalities: ["AUDIO"],
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    tools: [{ functionDeclarations: liveFunctionDeclarations(input.tools) }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  stripThinking(setup);
  return { setup };
}

export function liveWebSocketUrl(wsUrl: string, token: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set("access_token", token);
  return url.toString();
}

export function buildLiveAudioInput(base64: string): string {
  return JSON.stringify({
    realtimeInput: {
      audio: { data: base64, mimeType: "audio/pcm;rate=16000" },
    },
  });
}

export function buildLiveTextInput(text: string): string {
  return JSON.stringify({ realtimeInput: { text } });
}

/**
 * Gemini 3.8 Live mid-session update. Replaces the system instruction and the
 * entire tool list. Callers pass the full pack tool list so set_series and
 * web_search are not dropped.
 */
export function buildLiveContextUpdate(input: {
  systemInstruction: string;
  tools: readonly LiveToolDeclaration[];
}): string {
  return JSON.stringify({
    contextUpdate: {
      systemInstruction: { parts: [{ text: input.systemInstruction }] },
      tools: { tools: [{ functionDeclarations: liveFunctionDeclarations(input.tools) }] },
    },
  });
}

export function buildLiveToolResponse(
  calls: Array<{ id?: string; name: string; response: Record<string, unknown> }>
): string {
  return JSON.stringify({
    toolResponse: {
      functionResponses: calls.map((call) => ({
        id: call.id,
        name: call.name,
        response: call.response,
      })),
    },
  });
}

export function downsampleToPcm16(
  samples: Float32Array,
  inputRate: number,
  outputRate = 16000
): Int16Array {
  if (samples.length === 0 || inputRate <= 0 || outputRate <= 0) return new Int16Array();
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += samples[j] ?? 0;
      count += 1;
    }
    const sample = count > 0 ? sum / count : samples[start] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return typeof record?.text === "string" ? record.text : "";
}

function sampleRateOf(mime: unknown): number {
  const match = typeof mime === "string" ? mime.match(/rate=(\d+)/) : null;
  const rate = match ? Number(match[1]) : 24000;
  return Number.isFinite(rate) && rate > 0 ? rate : 24000;
}

function sourcesFrom(value: unknown): LiveSource[] {
  const record = asRecord(value);
  const chunks = record?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const sources: LiveSource[] = [];
  for (const chunk of chunks) {
    const web = asRecord(asRecord(chunk)?.web);
    const url = typeof web?.uri === "string" ? web.uri : typeof web?.url === "string" ? web.url : "";
    if (!url) continue;
    sources.push({ url, title: typeof web?.title === "string" && web.title ? web.title : url });
  }
  return sources;
}

/** Parse one Live server message into the events the session should apply. */
export function parseLiveServerMessage(raw: string): LiveServerEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ type: "error", message: "Live session sent a message that was not JSON." }];
  }
  const message = asRecord(parsed);
  if (!message) return [];
  const events: LiveServerEvent[] = [];

  if ("setupComplete" in message) events.push({ type: "setupComplete" });

  const error = message.error;
  if (typeof error === "string" && error) events.push({ type: "error", message: error });
  const errorRecord = asRecord(error);
  if (typeof errorRecord?.message === "string" && errorRecord.message) {
    events.push({ type: "error", message: errorRecord.message });
  }

  const toolCall = asRecord(message.toolCall);
  const functionCalls = toolCall?.functionCalls;
  if (Array.isArray(functionCalls)) {
    const calls: LiveToolCall[] = [];
    for (const item of functionCalls) {
      const call = asRecord(item);
      const name = typeof call?.name === "string" ? call.name : "";
      if (!name) continue;
      const args = asRecord(call?.args) ?? {};
      calls.push({
        name,
        args,
        id: typeof call?.id === "string" ? call.id : undefined,
      });
    }
    if (calls.length) events.push({ type: "toolCall", calls });
  }

  const server = asRecord(message.serverContent);
  if (server) {
    const parts = asRecord(server.modelTurn)?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const inline = asRecord(asRecord(part)?.inlineData);
        const data = typeof inline?.data === "string" ? inline.data : "";
        if (data) {
          events.push({
            type: "audio",
            base64: data,
            sampleRate: sampleRateOf(inline?.mimeType),
          });
        }
      }
    }
    const input = textOf(server.inputTranscription);
    if (input) events.push({ type: "inputTranscript", text: input });
    const output = textOf(server.outputTranscription);
    if (output) events.push({ type: "outputTranscript", text: output });
    const sources = sourcesFrom(server.groundingMetadata);
    if (sources.length) events.push({ type: "sources", sources });
    if (server.interrupted === true) events.push({ type: "interrupted" });
    if (server.turnComplete === true) events.push({ type: "turnComplete" });
  }

  return events;
}
