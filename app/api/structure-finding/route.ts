// POST /api/structure-finding
// Body: { transcript: string }
// Returns strict JSON: { label, description, teachingPoints: string[] }
//
// The tutor dictates a finding freely; Gemini Flash structures it. JSON-only,
// low temperature, defensive parsing.

import { NextRequest, NextResponse } from "next/server";
import { generate, parseJsonLoose } from "@/lib/gemini";
import type { StructuredFinding } from "@/lib/types";

export const runtime = "nodejs";

const SYSTEM = `You structure a radiologist's dictated finding into JSON for a teaching tool.
Return ONLY a JSON object — no prose, no markdown, no code fences — with EXACTLY this shape:
{
  "label": string,          // short finding name, e.g. "ACL tear"
  "description": string,    // one or two sentences describing the finding
  "teachingPoints": string[] // 0-4 concise teaching points / associated signs
}
Rules:
- Use the radiologist's words; do not invent findings not in the transcript.
- "label" is a terse title (2-5 words). "description" is full prose.
- If no teaching points are mentioned, return an empty array.
- Output must be valid JSON parseable by JSON.parse.`;

export async function POST(req: NextRequest) {
  try {
    const { transcript } = await req.json();
    if (typeof transcript !== "string" || transcript.trim() === "") {
      return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    }

    const result = await generate({
      systemInstruction: SYSTEM,
      temperature: 0.1,
      jsonOnly: true,
      contents: [{ role: "user", parts: [{ text: transcript }] }],
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
