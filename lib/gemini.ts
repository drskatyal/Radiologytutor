// ============================================================================
// lib/gemini.ts
//
// Thin server-only wrapper over the Google AI Studio (Gemini) REST API.
// Never import this into client components — it reads GEMINI_API_KEY.
//
// We hit the REST endpoint directly with fetch to avoid SDK version churn.
// Model is configurable via GEMINI_MODEL (default: a latest Flash model).
// ============================================================================

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

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
}

export interface GeminiResult {
  text: string;
  functionCalls: { name: string; args: Record<string, unknown> }[];
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
  if (opts.tools && opts.tools.length > 0) {
    body.tools = [{ functionDeclarations: opts.tools }];
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
  const parts: GeminiPart[] = data?.candidates?.[0]?.content?.parts ?? [];

  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("");

  const functionCalls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));

  return { text, functionCalls };
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

/** A viewer action the teaching plan may return for the frontend to execute. */
export interface TeachingViewerAction {
  /** show_finding (jump to a finding) | next_in_tour | prev_in_tour | none. */
  type: "show_finding" | "next_in_tour" | "prev_in_tour" | "set_window" | "none";
  findingId?: string;
  /** For set_window: target VOI. */
  windowWidth?: number;
  windowCenter?: number;
}

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
  mode: "guided" | "socratic" | "free";
  /** Compact, ordered finding context the tutor reasons over. */
  findingsContext: string;
  /** The finding the student is currently looking at (for "what is this?"). */
  currentFindingId?: string;
}

export interface TeachingPlanResult {
  /** The spoken/written answer (TTS-safe: no markdown, no spoken IDs). */
  answer: string;
  /** Optional viewer action the frontend executes (drive the viewer). */
  action: TeachingViewerAction;
}

/** Tools the tutor uses to drive our self-hosted viewer. */
const TEACHING_TOOLS: FunctionDeclaration[] = [
  {
    name: "show_finding",
    description:
      "Drive the viewer to a specific finding (animating camera/window/slice), reveal its marker, and narrate it. Use the finding's id.",
    parameters: {
      type: "object",
      properties: { findingId: { type: "string", description: "Finding id, e.g. f1" } },
      required: ["findingId"],
    },
  },
  {
    name: "next_in_tour",
    description: "Advance to the next finding in tour order and narrate it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "prev_in_tour",
    description: "Go back to the previous finding in tour order.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "set_window",
    description:
      "Adjust the window width / center (VOI) on the current view to make a feature more conspicuous.",
    parameters: {
      type: "object",
      properties: {
        windowWidth: { type: "number" },
        windowCenter: { type: "number" },
      },
      required: ["windowWidth", "windowCenter"],
    },
  },
];

function teachingSystemPrompt(input: TeachingPlanInput): string {
  const base = `You are a warm, expert radiology tutor guiding a student through the case "${input.caseTitle}" (${input.modality}).
You drive a self-hosted medical image viewer ONLY through these tools: show_finding, next_in_tour, prev_in_tour, set_window.
You cannot see the pixels yourself — reason from the finding list below.
${input.currentFindingId ? `The student is currently viewing finding id=${input.currentFindingId}.` : ""}

Findings (in tour order):
${input.findingsContext}

Rules:
- When the student should see something, CALL the matching tool AND narrate in the same turn.
- Narration: 1-3 spoken sentences, warm exam-room tone, suitable for text-to-speech — no markdown, no bullet symbols, never speak IDs aloud.
- Match free-text requests ("show me the effusion") to the closest finding and call show_finding.`;

  if (input.mode === "socratic") {
    return (
      base +
      `\n\nMODE: SOCRATIC. Do not reveal a finding until the student has attempted it. Prompt and hint first; only call show_finding once they've made an attempt or explicitly ask for the answer.`
    );
  }
  if (input.mode === "free") {
    return (
      base +
      `\n\nMODE: FREE EXPLORE. The student navigates on their own. Answer questions; do not auto-advance.`
    );
  }
  return (
    base +
    `\n\nMODE: GUIDED TOUR. Walk the findings in order. On "next"/"continue" call next_in_tour; on "back" call prev_in_tour. Answer questions along the way without losing the student's place.`
  );
}

function toAction(call?: { name: string; args: Record<string, unknown> }): TeachingViewerAction {
  if (!call) return { type: "none" };
  switch (call.name) {
    case "show_finding":
      return { type: "show_finding", findingId: String(call.args.findingId ?? "") };
    case "next_in_tour":
      return { type: "next_in_tour" };
    case "prev_in_tour":
      return { type: "prev_in_tour" };
    case "set_window":
      return {
        type: "set_window",
        windowWidth: Number(call.args.windowWidth),
        windowCenter: Number(call.args.windowCenter),
      };
    default:
      return { type: "none" };
  }
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
    contents,
  });

  return {
    answer: result.text,
    action: toAction(result.functionCalls[0]),
  };
}
