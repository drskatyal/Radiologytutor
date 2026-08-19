// POST /api/structure-finding
// Body: { transcript: string }  OR  { audioBase64, audioMime }
// Returns strict JSON: { label, description, teachingPoints: string[] }
//
// The tutor dictates a finding freely (typed transcript or recorded audio);
// Gemini Flash does STT (for audio) + structures it. JSON-only, low
// temperature, defensive parsing.

import { NextRequest, NextResponse } from "next/server";
import { generate, parseJsonLoose, userParts } from "@/lib/gemini";
import { STRUCTURE_FINDING_SYSTEM } from "@/lib/teachingPrompt";
import type { StructuredFinding } from "@/lib/types";

export const runtime = "nodejs";

const SYSTEM = STRUCTURE_FINDING_SYSTEM;

export async function POST(req: NextRequest) {
  try {
    const { transcript, audioBase64, audioMime } = await req.json();
    if ((typeof transcript !== "string" || transcript.trim() === "") && !audioBase64) {
      return NextResponse.json(
        { error: "transcript or audioBase64 is required" },
        { status: 400 }
      );
    }

    const parts = userParts({
      text:
        typeof transcript === "string" && transcript.trim()
          ? transcript
          : "Transcribe this dictation and structure the finding.",
      audioBase64,
      audioMime,
    });

    const result = await generate({
      systemInstruction: SYSTEM,
      temperature: 0.1,
      jsonOnly: true,
      contents: [{ role: "user", parts }],
    });

    const parsed = parseJsonLoose<Partial<StructuredFinding>>(result.text);

    // Defensive normalisation.
    const finding: StructuredFinding = {
      label: typeof parsed.label === "string" ? parsed.label : "Untitled finding",
      description: typeof parsed.description === "string" ? parsed.description : "",
      teachingPoints: Array.isArray(parsed.teachingPoints)
        ? parsed.teachingPoints.filter((p): p is string => typeof p === "string")
        : [],
    };

    return NextResponse.json(finding);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
