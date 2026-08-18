// ============================================================================
// lib/gemini.ts
//
// Thin server-only wrapper over the Google AI Studio (Gemini) REST API.
// Never import this into client components — it reads GEMINI_API_KEY.
//
// We hit the REST endpoint directly with fetch to avoid SDK version churn.
// Model is configurable via GEMINI_MODEL (default: current Flash workhorse).
// ============================================================================

import { teachingSystemPrompt } from "./teachingPrompt";
import {
  HARNESS_VIEWER_TOOLS,
  harnessActionFromCall,
  type HarnessViewerAction,
} from "./harness/tools";

/** Orchestration / STT / tools. Override via GEMINI_MODEL when Google ships next Flash. */
const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Viewer action alias — canonical definition lives in lib/harness/tools. */
export type TeachingViewerAction = HarnessViewerAction;

export interface GeminiPart {
  text?: string;
  /** Inline audio/image bytes (base64). Gemini Flash is multimodal — we send
   * mic audio here so Gemini does STT + reasoning in one call. */
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

/** Build a user content part list from optional text + optional audio. */
export function userParts(opts: {
  text?: string;
  audioBase64?: string;
  audioMime?: string;
}): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (opts.audioBase64) {
    parts.push({
      inlineData: { mimeType: opts.audioMime || "audio/webm", data: opts.audioBase64 },
    });
  }
  if (opts.text) parts.push({ text: opts.text });
  if (parts.length === 0) parts.push({ text: "" });
  return parts;
}

export interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GenerateOptions {
  contents: GeminiContent[];
  systemInstruction?: string;
  temperature?: number;
  /** Force strict JSON output (authoring call). */
  jsonOnly?: boolean;
  tools?: FunctionDeclaration[];
  /** Enable Gemini's built-in Google Search grounding tool (web-grounded). */
  googleSearch?: boolean;
}

/** A web source surfaced by Google Search grounding. */
export interface GroundingSource {
  title: string;
  url: string;
}

export interface GeminiResult {
  text: string;
  functionCalls: { name: string; args: Record<string, unknown> }[];
  /** Deduped web sources from grounding metadata (empty when not grounded). */
  sources: GroundingSource[];
}

function requireKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env.local and add your Google AI Studio key."
    );
  }
  return key;
}

/** Whether a Gemini key is configured. Lets routes degrade gracefully. */
export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function generate(opts: GenerateOptions): Promise<GeminiResult> {
  const key = requireKey();

  const body: Record<string, unknown> = {
    contents: opts.contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      ...(opts.jsonOnly ? { responseMimeType: "application/json" } : {}),
    },
  };

  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }
  // Tools: our viewer function declarations and/or Gemini's built-in Google
  // Search grounding. Current Gemini Flash supports both in one request; each
  // tool is its own entry in the `tools` array.
  const toolEntries: Record<string, unknown>[] = [];
  if (opts.tools && opts.tools.length > 0) {
    toolEntries.push({ functionDeclarations: opts.tools });
  }
  if (opts.googleSearch) {
    toolEntries.push({ google_search: {} });
  }
  if (toolEntries.length > 0) {
    body.tools = toolEntries;
  }

  const res = await fetch(
    `${API_BASE}/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const parts: GeminiPart[] = candidate?.content?.parts ?? [];

  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("");

  const functionCalls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));

  return { text, functionCalls, sources: extractSources(candidate) };
}

/**
 * Pull web citations out of a candidate's grounding metadata. The Google Search
 * tool returns sources under `groundingMetadata.groundingChunks[].web.{uri,title}`.
 * We dedupe by URL and cap the list so the chat stays tidy.
 */
function extractSources(candidate: unknown, cap = 5): GroundingSource[] {
  const chunks =
    (candidate as { groundingMetadata?: { groundingChunks?: unknown[] } })
      ?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources: GroundingSource[] = [];
  for (const chunk of chunks) {
    const web = (chunk as { web?: { uri?: string; title?: string } })?.web;
    const url = web?.uri?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: web?.title?.trim() || url });
    if (sources.length >= cap) break;
  }
  return sources;
}

/** Strip ```json fences / stray prose and parse the first JSON object. */
export function parseJsonLoose<T>(raw: string): T {
  let s = raw.trim();
  // Remove markdown code fences.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // If there's surrounding prose, grab the outermost {...}.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  return JSON.parse(s) as T;
}

// ============================================================================
// Student voice Q&A — TWO distinct calls (CLAUDE.md §2), never merged:
//   1. transcribeAudio  — Gemini STT only (audio -> text). No reasoning.
//   2. runTeachingPlan  — Gemini teaching (case + findings + question -> answer
//                          + optional viewer action). Text in, text out.
// ============================================================================

/**
 * CALL 1 — speech-to-text only. Transcribes the student's spoken question with
 * Gemini's multimodal STT. We constrain it hard to a verbatim transcript so it
 * never "answers" here — the teaching reasoning happens in call 2.
 */
export async function transcribeAudio(
  audioBase64: string,
  audioMime = "audio/webm"
): Promise<string> {
  const result = await generate({
    systemInstruction:
      "You are a speech-to-text transcriber. Transcribe the spoken audio to plain text " +
      "VERBATIM. Do not answer, translate, summarize, or add anything. Output only the " +
      "transcript. If the audio is silent or unintelligible, output an empty string.",
    temperature: 0,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: audioMime || "audio/webm", data: audioBase64 } },
          { text: "Transcribe this audio." },
        ],
      },
    ],
  });
  return result.text.trim();
}

/** @deprecated Use TeachingViewerAction (harness). Kept as comment anchor. */
// Viewer actions: see HarnessViewerAction in lib/harness/tools.ts

export interface TeachingTurn {
  role: "user" | "assistant";
  text: string;
}

export interface TeachingPlanInput {
  /** Spoken-text question (already transcribed) or typed question. */
  question: string;
  /** Prior chat turns for continuity (excluding the current question). */
  history: TeachingTurn[];
  caseTitle: string;
  modality: string;
  mode: "guided" | "socratic" | "free" | "reporting" | "viva";
  /** Compact, ordered finding context the tutor reasons over. */
  findingsContext: string;
  /** The finding the student is currently looking at (for "what is this?"). */
  currentFindingId?: string;
}

export interface TeachingPlanResult {
  /** The spoken/written answer (TTS-safe: no markdown, no spoken IDs). */
  answer: string;
  /** First viewer action (back-compat). Prefer `actions` for interleave. */
  action: TeachingViewerAction;
  /** Ordered tool calls for this turn — one beat can drive several. */
  actions: TeachingViewerAction[];
  /** Web sources from Google Search grounding (deduped, capped). */
  sources: GroundingSource[];
}

/** Tools the tutor uses to drive our self-hosted viewer (harness registry). */
const TEACHING_TOOLS: FunctionDeclaration[] = HARNESS_VIEWER_TOOLS;

function toAction(call?: {
  name: string;
  args: Record<string, unknown>;
}): TeachingViewerAction {
  return harnessActionFromCall(call);
}

/**
 * CALL 2 — the teaching plan. Text question + case/findings context in; answer
 * text + optional viewer action out. No audio here (that was call 1).
 */
export async function runTeachingPlan(input: TeachingPlanInput): Promise<TeachingPlanResult> {
  const contents: GeminiContent[] = input.history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.text }],
  }));
  contents.push({
    role: "user",
    parts: [{ text: input.question || "Begin the session." }],
  });

  const result = await generate({
    systemInstruction: teachingSystemPrompt(input),
    temperature: 0.4,
    tools: TEACHING_TOOLS,
    // Web-grounded teaching: answers cite current radiology references.
    googleSearch: true,
    contents,
  });

  const actions = result.functionCalls
    .map((call) => toAction(call))
    .filter((a) => a.type !== "none");

  return {
    answer: result.text,
    action: actions[0] ?? { type: "none" },
    actions,
    sources: result.sources,
  };
}

// ============================================================================
// Text-to-speech — Gemini TTS fallback inside the voice seam (lib/voice.ts).
// Prefer ElevenLabs cloned teacher voice when enrolled. Server-only.
// Used ONLY for live tutor answers, never for recorded lesson narration.
// ============================================================================

const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
/** Warm, clear default voice. Override with GEMINI_TTS_VOICE. */
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || "Kore";
/** Gemini TTS returns 16-bit signed PCM, mono, at this sample rate. */
const TTS_SAMPLE_RATE = 24000;

export interface SynthesizedSpeech {
  /** WAV-wrapped audio bytes ready to stream to an <audio> element. */
  audio: Buffer;
  mimeType: "audio/wav";
}

/**
 * Synthesize speech for the given text with Gemini TTS. Returns WAV bytes (we
 * wrap the raw PCM the API returns in a 44-byte WAV header so the browser can
 * play it directly). Throws if the key is missing or the API errors.
 */
export async function synthesizeSpeech(text: string): Promise<SynthesizedSpeech> {
  const key = requireKey();

  const body = {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } },
      },
    },
  };

  const res = await fetch(
    `${API_BASE}/models/${TTS_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini TTS error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) {
    throw new Error("Gemini TTS returned no audio.");
  }

  const pcm = Buffer.from(inline.data, "base64");
  // mimeType is like "audio/L16;codec=pcm;rate=24000"; honour an explicit rate.
  const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? "");
  const sampleRate = rateMatch ? Number(rateMatch[1]) : TTS_SAMPLE_RATE;

  return { audio: pcmToWav(pcm, sampleRate), mimeType: "audio/wav" };
}

/** Prepend a 44-byte WAV header to raw 16-bit mono PCM. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
