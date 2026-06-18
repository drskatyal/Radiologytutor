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
