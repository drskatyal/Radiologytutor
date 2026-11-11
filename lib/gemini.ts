import { assertNoPhi } from "./phiGuard";
import { assertGeminiCapability, stripDeprecatedSampling } from "./geminiPolicy";
import { hashContent } from "./findingContent";
import type { GeminiRequestMetadata } from "./geminiMetadata";
import { ttsAudioToWav, TtsAudioError } from "./tts.wav";
export { GeminiCapabilityError } from "./geminiPolicy";
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
  type SpokenFindingSource,
} from "./tutorSpeech";
import {
  HARNESS_VIEWER_TOOLS,
  harnessActionFromCall,
  type HarnessViewerAction,
} from "./harness/tools";
import { sanitizeSeriesActions } from "./setSeries";

/** Orchestration / STT / tools. Gemini 3.8 Flash (stable). Override with GEMINI_MODEL. */
export const GEMINI_MODEL_DEFAULT = "gemini-3.8-flash";
export const GEMINI_TTS_MODEL_DEFAULT = "gemini-3.8-flash-tts";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Viewer action alias — canonical definition lives in lib/harness/tools. */
export type TeachingViewerAction = HarnessViewerAction;

export type MediaResolutionLevel = "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
export class GeminiConfigurationError extends Error {
  readonly code = "GEMINI_INVALID_CONFIGURATION";
  constructor(message: string) { super(message); this.name = "GeminiConfigurationError"; }
}
export class GeminiApiError extends Error {
  readonly code = "GEMINI_API_ERROR";
  constructor(public readonly model: string, public readonly status: number) {
    super(`Gemini API error ${status}`); this.name = "GeminiApiError";
  }
}

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
  mediaResolution?: MediaResolutionLevel | { level: MediaResolutionLevel };
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
  timeoutMs = REQUEST_TIMEOUT_MS,
  apiSurface: GeminiRequestMetadata["apiSurface"] = "generateContent"
): Promise<Response> {
  assertNoPhi(body);
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(apiSurface === "interactions" ? `${API_BASE}/interactions` : `${API_BASE}/models/${model}:generateContent`, {
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
        throw new GeminiApiError(model, res.status);
      }
      console.warn(`[gemini] ${model} -> ${res.status}, retrying (${attempt}/${MAX_ATTEMPTS})`);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (err instanceof GeminiApiError) {
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
  throw new GeminiApiError(model, lastStatus || 500);
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

export interface GenerateOptions {
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
  modelMetadata: GeminiRequestMetadata;
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

/** Normalize only at the transport boundary; internal callers may use either form. */
export function buildGenerateRequest(opts: GenerateOptions, model: string, form = process.env.GEMINI_MEDIA_RESOLUTION_FORM || "object"): Record<string, unknown> {
  assertGeminiCapability(model, "text");
  if (form !== "object" && form !== "string") throw new GeminiConfigurationError("GEMINI_MEDIA_RESOLUTION_FORM must be object or string.");
  const contents = opts.contents.map(content => ({ ...content, parts: content.parts.map(part => {
    const mime = part.inlineData?.mimeType ?? part.fileData?.mimeType;
    if (!part.mediaResolution && !/^(?:image|video)\//.test(mime ?? "")) return { ...part };
    const level = typeof part.mediaResolution === "object" ? part.mediaResolution.level : part.mediaResolution ?? "MEDIA_RESOLUTION_LOW";
    if (!["MEDIA_RESOLUTION_LOW", "MEDIA_RESOLUTION_MEDIUM", "MEDIA_RESOLUTION_HIGH"].includes(level)) throw new GeminiConfigurationError("Unsupported media resolution level.");
    return { ...part, mediaResolution: form === "object" ? { level } : level };
  }) }));

  const body: Record<string, unknown> = {
    contents,
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

  stripDeprecatedSampling(model, body.generationConfig as Record<string, unknown>);
  return body;
}

function recordRequest(model: string, apiSurface: GeminiRequestMetadata["apiSurface"], body: unknown, responseModelVersion: unknown): GeminiRequestMetadata {
  const metadata: GeminiRequestMetadata = {
    requestedModel: model,
    responseModelVersion: typeof responseModelVersion === "string" ? responseModelVersion : null,
    apiSurface,
    configHash: hashContent({ model, apiSurface, body }),
  };
  // Audit only configuration identity: no prompt, media, credential or clinical text.
  console.info("[gemini.request]", JSON.stringify(metadata));
  return metadata;
}

export async function generate(opts: GenerateOptions): Promise<GeminiResult> {
  const model = process.env.GEMINI_MODEL?.trim() || GEMINI_MODEL_DEFAULT;
  const body = buildGenerateRequest(opts, model);
  const res = await callGemini(model, requireKey(), body, opts.timeoutMs);
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

  return { text, functionCalls, sources: extractSources(candidate), modelMetadata: recordRequest(model, "generateContent", body, data?.modelVersion) };
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
  modelMetadata?: GeminiRequestMetadata;
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
  return { transcript, segments, modelMetadata: result.modelMetadata };
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
  /** Series catalog (`formatSeriesCatalog`). UIDs the model may copy. */
  seriesCatalog?: string;
  /** The finding the student is currently looking at (for "what is this?"). */
  currentFindingId?: string;
  /**
   * SeriesInstanceUIDs set_series / scroll_to may name. When set, any other
   * UID is removed before the reply leaves the server.
   */
  seriesAllowlist?: readonly string[];
  /**
   * Authored findings used only when the model returns tools and no speech.
   * The spoken fallback copies label / description / teaching points from here.
   */
  findings?: SpokenFindingSource[];
}

export interface TeachingPlanResult {
  /** Absent for the neutral exam response, which makes no model request. */
  modelMetadata?: GeminiRequestMetadata;
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
  // Examinations use the isolated text-structuring path, never a rubric-bearing tutor request.
  if (input.mode === "viva" || input.mode === "socratic") return { answer: "Describe what you see on this series.", action: { type: "none" }, actions: [], sources: [] };
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

  const seated = called;
  const actions = input.seriesAllowlist
    ? sanitizeSeriesActions(seated, new Set(input.seriesAllowlist))
    : seated;

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
    modelMetadata: result.modelMetadata,
  };
}

// ============================================================================
// Text-to-speech — Gemini TTS fallback inside the voice seam (lib/voice.ts).
// Prefer ElevenLabs cloned teacher voice when enrolled. Server-only.
// Used ONLY for live tutor answers, never for recorded lesson narration.
// ============================================================================

export interface SynthesizedSpeech {
  /** Complete WAV, preserved from unary output or wrapped from raw audio/l16. */
  audio: Buffer;
  mimeType: "audio/wav";
  modelMetadata: GeminiRequestMetadata;
}

/** Delivery direction is metadata, never prepended to the spoken text. */
export const ATTENDING_TTS_DIRECTION = "Calm attending radiologist voice, measured pace, verbatim, with no preamble.";

export function buildTtsRequest(text: string, model: string, voice: string, opts?: { persona?: "attending" }) {
  assertGeminiCapability(model, "tts");
  return {
    model,
    input: [{ type: "user_input", content: [{
      type: "text", text,
      annotations: [{ type: "speech_metadata", style: opts?.persona === "attending" ? ATTENDING_TTS_DIRECTION : "Clear, natural delivery, verbatim, with no preamble." }],
    }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice }] },
  };
}

export async function synthesizeSpeech(text: string, opts?: { persona?: "attending" }): Promise<SynthesizedSpeech> {
  const model = process.env.GEMINI_TTS_MODEL?.trim() || GEMINI_TTS_MODEL_DEFAULT;
  const body = buildTtsRequest(text, model, process.env.GEMINI_TTS_VOICE?.trim() || "Kore", opts);
  const res = await callGemini(model, requireKey(), body, undefined, "interactions");
  const data = await res.json();
  const modelMetadata = recordRequest(model, "interactions", body, data?.model_version ?? data?.modelVersion);
  // REST response shape documented in speech-generation#single-speaker. The
  // SDK's output_audio convenience accessor is not the REST response contract.
  const audioParts: Array<{ data?: string; mime_type?: string }> = (Array.isArray(data?.steps) ? data.steps : [])
    .filter((step: { type?: string }) => step?.type === "model_output")
    .flatMap((step: { content?: unknown[] }) => Array.isArray(step.content) ? step.content : [])
    .filter((part: { type?: string }) => part?.type === "audio");
  const audio = audioParts[audioParts.length - 1];
  if (typeof audio?.data !== "string" || !audio.data) throw new TtsAudioError("Gemini TTS returned no audio.");
  return { audio: ttsAudioToWav(Buffer.from(audio.data, "base64"), audio.mime_type), mimeType: "audio/wav", modelMetadata };
}
