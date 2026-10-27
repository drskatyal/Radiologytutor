// ============================================================================
// lib/gemini.ts
//
// Thin server-only wrapper over the Google AI Studio (Gemini) REST API.
// Never import this into client components — it reads GEMINI_API_KEY.
//
// We hit the REST endpoint directly with fetch to avoid SDK version churn.
// Model is configurable via GEMINI_MODEL (default: gemini-3.8-flash).
// ============================================================================

import { teachingSystemPrompt } from "./teachingPrompt";
import {
  ensureSpokenAnswer,
  examHintLevel,
  seatExamReveal,
  type SpokenFindingSource,
} from "./tutorSpeech";
import {
  HARNESS_VIEWER_TOOLS,
  harnessActionFromCall,
  type HarnessViewerAction,
} from "./harness/tools";

/** Orchestration / STT / tools. Gemini 3.8 Flash (stable). Override with GEMINI_MODEL. */
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Viewer action alias — canonical definition lives in lib/harness/tools. */
export type TeachingViewerAction = HarnessViewerAction;

export interface GeminiPart {
  text?: string;
  /** Inline audio/image/video bytes (base64). */
  inlineData?: { mimeType: string; data: string };
  /** Files API reference. Used for a long viewport recording. */
  fileData?: { fileUri: string; mimeType: string };
  /**
   * Video only. AGENTIC lets Flash walk a long viewer recording without
   * tokenizing every frame. STATIC is the fixed-rate pass for a short take.
   */
  mediaProcessing?: "AGENTIC" | "STATIC";
  /** DICOM viewport video stays low unless overlay text must be read. */
  mediaResolution?: "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}


// ---------------------------------------------------------------------------
// Transport
//
// One place that actually talks to Google, so timeout/retry/auth behaviour is
// consistent across every call. Three things worth stating explicitly:
//
//   * The key goes in the `x-goog-api-key` HEADER, never the query string.
//     Query strings are logged by proxies, CDNs and error reporters; an API key
//     in one is an API key in a log file.
//   * Every request has a deadline. Without one, a hung upstream pins a
//     serverless invocation until the platform kills it.
//   * Retries are limited to transient failures (429 and 5xx) with backoff.
//     A 400 is our bug and retrying it just spends money twice.
// ---------------------------------------------------------------------------

/** Wall-clock deadline for a single Gemini call. */
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 45_000);
const MAX_ATTEMPTS = 3;

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function backoffMs(attempt: number): number {
  // 400ms, 1200ms — deterministic, no jitter needed at this concurrency.
  return 400 * Math.pow(3, attempt - 1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to a Gemini model endpoint with a deadline and bounded retries.
 * Throws a message that names the status but NOT the upstream body — callers
 * log the detail server-side and return something generic to the client.
 */
async function callGemini(
  model: string,
  key: string,
  body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return res;

      lastStatus = res.status;
      const detail = await res.text().catch(() => "");
      if (!isRetryable(res.status) || attempt === MAX_ATTEMPTS) {
        console.error(`[gemini] ${model} -> ${res.status}: ${detail.slice(0, 500)}`);
        throw new Error(`Gemini API error ${res.status}`);
      }
      console.warn(`[gemini] ${model} -> ${res.status}, retrying (${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (!aborted && err instanceof Error && err.message.startsWith("Gemini API error")) {
        throw err;
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          aborted
            ? `Gemini request timed out after ${timeoutMs}ms`
            : `Gemini request failed: network error`
        );
      }
      console.warn(`[gemini] ${model} attempt ${attempt} failed, retrying`);
    } finally {
      clearTimeout(timer);
    }
    await sleep(backoffMs(attempt));
  }
  throw new Error(`Gemini API error ${lastStatus || 500}`);
}

/** Build a user content part list from optional stills, audio, and text. */
export function userParts(opts: {
  text?: string;
  audioBase64?: string;
  audioMime?: string;
  /** Viewport stills. Each caption is a text part immediately before the image. */
  images?: Array<{ mimeType: string; data: string; caption?: string }>;
  /** Viewer-only recording. Flash compile only — never sent to Gemini Live. */
  video?: { data: string; mimeType: string; mediaProcessing: "AGENTIC" | "STATIC" };
}): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (opts.video?.data) {
    parts.push({
      inlineData: { mimeType: opts.video.mimeType || "video/webm", data: opts.video.data },
      mediaProcessing: opts.video.mediaProcessing,
    });
  }
  for (const image of opts.images ?? []) {
    if (!image?.data) continue;
    if (image.caption) parts.push({ text: image.caption });
    parts.push({
      inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.data },
    });
  }
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
  /** Override the default deadline. Agentic video needs longer than a text call. */
  timeoutMs?: number;
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
  // Tools: viewer function declarations and/or Google Search. Each tool is
  // its own entry. Gemini 3 returns 400 when both are set unless tool context
  // circulation is on. The error names the proto field
  // tool_config.include_server_side_tool_invocations; this REST body uses the
  // camelCase JSON name, same as generationConfig and functionDeclarations.
  const toolEntries: Record<string, unknown>[] = [];
  const hasFunctionDeclarations = Boolean(opts.tools && opts.tools.length > 0);
  if (hasFunctionDeclarations) {
    toolEntries.push({ functionDeclarations: opts.tools });
  }
  if (opts.googleSearch) {
    toolEntries.push({ google_search: {} });
  }
  if (toolEntries.length > 0) {
    body.tools = toolEntries;
  }
  if (hasFunctionDeclarations && opts.googleSearch) {
    body.toolConfig = { includeServerSideToolInvocations: true };
  }

  const res = await callGemini(MODEL, key, body, opts.timeoutMs);
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

export interface NarrationTranscript {
  transcript: string;
  segments: Array<{ tStartMs?: number; tEndMs?: number; text?: string }>;
}

/**
 * Transcribe a teaching take into verbatim text plus sentence segments.
 * Segment times are the model's estimate of when it heard each phrase.
 * Callers must run them through coerceNarrationSpans — a missing or single
 * full-take span is not alignment.
 */
export async function transcribeNarrationTake(
  audioBase64: string,
  audioMime: string,
  durationMs: number
): Promise<NarrationTranscript> {
  const duration = Math.max(0, Math.round(durationMs));
  const result = await generate({
    systemInstruction:
      "You transcribe a radiologist teaching at a workstation. Return ONLY JSON with exactly " +
      '{ "transcript": string, "segments": [ { "tStartMs": number, "tEndMs": number, "text": string } ] }. ' +
      "transcript is the full verbatim speech. segments are sentence-sized slices of that transcript, in order. " +
      `tStartMs and tEndMs are milliseconds from the start of this audio, within 0..${duration || "the audio length"}. ` +
      "Estimate each phrase from when you hear it. Do not invent words, findings, or measurements. " +
      "If the audio is silent, transcript is an empty string and segments is an empty array.",
    temperature: 0,
    jsonOnly: true,
    contents: [
      {
        role: "user",
        parts: userParts({
          text: `durationMs=${duration}. Transcribe and segment.`,
          audioBase64,
          audioMime,
        }),
      },
    ],
  });
  const parsed = parseJsonLoose<Partial<NarrationTranscript>>(result.text);
  const transcript = typeof parsed.transcript === "string" ? parsed.transcript.trim() : "";
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  return { transcript, segments };
}

/** @deprecated Use TeachingViewerAction (harness). Kept as comment anchor. */
// Viewer actions: see HarnessViewerAction in lib/harness/tools.ts

export interface TeachingTurn {
  role: "user" | "assistant";
  text: string;
  /** Finding this turn was about. Other findings do not climb the hint ladder. */
  findingId?: string;
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
  /**
   * Authored findings used only when the model returns tools and no speech.
   * The spoken fallback copies label / description / teaching points from here.
   */
  findings?: SpokenFindingSource[];
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

  const spokenFindings = input.findings ?? [];
  const hinted =
    spokenFindings.find((finding) => finding.id === input.currentFindingId) ??
    [...spokenFindings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  // Same rung the empty-text fallback speaks, so a partial answer is not told
  // to reveal just because the model may call show_finding.
  const hintLevel = examHintLevel({
    mode: input.mode,
    question: input.question,
    finding: hinted,
    findings: spokenFindings,
    history: input.history,
    currentFindingId: input.currentFindingId ?? hinted?.id,
  });

  const result = await generate({
    systemInstruction: teachingSystemPrompt({ ...input, hintLevel }),
    temperature: 0.4,
    tools: TEACHING_TOOLS,
    // Web-grounded teaching: answers cite current radiology references.
    googleSearch: true,
    contents,
  });

  const called = result.functionCalls
    .map((call) => toAction(call))
    .filter((a) => a.type !== "none");

  // Reveal without a seat leaves the slice still and Located unchanged.
  const actions =
    input.mode === "socratic" || input.mode === "viva"
      ? seatExamReveal(called, hintLevel, input.currentFindingId ?? hinted?.id)
      : called;

  // Tool-only replies leave Discussion blank and stall Teach on speech onEnd.
  // Fill a drive-first line from the authored finding; never invent anatomy.
  const answer = ensureSpokenAnswer({
    answer: result.text,
    mode: input.mode,
    question: input.question,
    actions,
    findings: spokenFindings,
    currentFindingId: input.currentFindingId,
    history: input.history,
  });

  return {
    answer,
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
 * Director note for teach-guide beats. Gemini TTS treats a short leading
 * instruction as style, then reads the line. We do not play the teacher's mic.
 */
export const ATTENDING_TTS_DIRECTION =
  "Say the following in a calm attending radiologist voice, measured pace, verbatim, with no preamble:";

export async function synthesizeSpeech(
  text: string,
  opts?: { persona?: "attending" }
): Promise<SynthesizedSpeech> {
  const key = requireKey();
  const spoken =
    opts?.persona === "attending" ? `${ATTENDING_TTS_DIRECTION}\n${text}` : text;

  const body = {
    contents: [{ role: "user", parts: [{ text: spoken }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } },
      },
    },
  };

  const res = await callGemini(TTS_MODEL, key, body);
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
