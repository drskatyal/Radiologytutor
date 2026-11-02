// POST /api/voice/search — session-gated web search for a Gemini Live tool call.
// The Live model calls web_search; this route runs Google Search via Flash and
// returns a short answer plus sources. The API key stays on the server.

import { NextResponse } from "next/server";
import { jsonAuthError, requireSession } from "@/lib/auth";
import { generate, geminiConfigured } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    await requireSession();
  } catch (err) {
    return jsonAuthError(err) ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!geminiConfigured()) {
    return NextResponse.json({ error: "Search is unavailable.", available: false }, { status: 503 });
  }

  let query = "";
  try {
    const body = (await req.json()) as { query?: unknown };
    query = typeof body.query === "string" ? body.query.trim().slice(0, 400) : "";
  } catch {
    query = "";
  }
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  try {
    const result = await generate({
      googleSearch: true,
      temperature: 0.2,
      systemInstruction:
        "Answer a radiology teaching question in 2–4 sentences. Use only what search supports. Do not invent a guideline, a measurement, or a diagnosis for a study you cannot see.",
      contents: [{ role: "user", parts: [{ text: query }] }],
    });
    return NextResponse.json({
      answer: result.text,
      sources: result.sources,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
