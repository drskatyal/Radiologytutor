// POST /api/structure-finding
// Body: { transcript: string }  OR  { audioBase64, audioMime, frames? }
// Returns strict JSON: { label, description, teachingPoints: string[] }
//
// A dictated finding (typed transcript or recorded audio). Optional viewport
// stills from a walk-through ride along so Flash can see the slice. The text
// fields are the only output — markers still come from the viewer track.
// JSON-only, low temperature, defensive parsing. Without stills the prompt
// matches the audio/transcript call.

import { NextRequest, NextResponse } from "next/server";
import { generate, parseJsonLoose, userParts } from "@/lib/gemini";
import { findingSystemInstruction } from "@/lib/compileSession";
import { coerceCompileFrames } from "@/lib/compileMedia";
import type { StructuredFinding } from "@/lib/types";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    await requireAuthorOrg();
    const body = await req.json();
    const transcript = body.transcript as string | undefined;
    const audioBase64 = body.audioBase64 as string | undefined;
    const audioMime = body.audioMime as string | undefined;
    const frames = coerceCompileFrames(body.frames);
    if ((typeof transcript !== "string" || transcript.trim() === "") && !audioBase64) {
      return NextResponse.json(
        { error: "transcript or audioBase64 is required" },
        { status: 400 }
      );
    }

    const baseText =
      typeof transcript === "string" && transcript.trim()
        ? transcript
        : "Transcribe this dictation and structure the finding.";
    const parts = userParts({
      text: frames.length
        ? `${baseText}\n\nViewport stills are attached. Use them with the dictation. Do not invent coordinates or measurements.`
        : baseText,
      audioBase64,
      audioMime,
      images: frames.map((frame) => ({
        mimeType: frame.mimeType,
        data: frame.base64,
        caption: `Viewport still at t=${frame.tMs}ms.`,
      })),
    });

    const result = await generate({
      systemInstruction: findingSystemInstruction(frames.length > 0),
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
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
