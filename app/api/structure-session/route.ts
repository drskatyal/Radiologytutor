// POST /api/structure-session
// Continuous authoring take → full transcript + ordered findings with time
// ranges. Body: { audioBase64, audioMime, durationMs, track? }
//
// Gemini STT + segmentation in one jsonOnly call. We then enrich each segment
// with suggestedMarker / suggestedSliceIndex from the recorded track clock so
// the author (and later the tutor) land on real pixels — never invented coords.

import { NextRequest, NextResponse } from "next/server";
import { generate, parseJsonLoose, userParts } from "@/lib/gemini";
import { STRUCTURE_SESSION_SYSTEM } from "@/lib/teachingPrompt";
import {
  markerNearTime,
  segmentMidMs,
  sliceNearTime,
} from "@/lib/captureSession";
import type {
  RecordedTrack,
  StructuredSession,
  StructuredSessionFinding,
} from "@/lib/types";

export const runtime = "nodejs";

const SYSTEM = STRUCTURE_SESSION_SYSTEM;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const audioBase64 = body.audioBase64 as string | undefined;
    const audioMime = (body.audioMime as string | undefined) || "audio/webm";
    const durationMs = Number(body.durationMs) || 0;
    const track = body.track as RecordedTrack | undefined;
    const transcriptHint =
      typeof body.transcript === "string" ? body.transcript.trim() : "";

    if (!audioBase64 && !transcriptHint) {
      return NextResponse.json(
        { error: "audioBase64 or transcript is required" },
        { status: 400 }
      );
    }

    const parts = userParts({
      text:
        (transcriptHint
          ? `Here is the transcript (prefer this if audio is also provided):\n${transcriptHint}\n\n`
          : "") +
        `Session durationMs=${durationMs || "unknown"}. ` +
        `Transcribe (if needed) and segment into teaching findings with time ranges.`,
      audioBase64,
      audioMime: audioBase64 ? audioMime : undefined,
    });

    const result = await generate({
      systemInstruction: SYSTEM,
      temperature: 0.15,
      jsonOnly: true,
      contents: [{ role: "user", parts }],
    });

    const parsed = parseJsonLoose<Partial<StructuredSession>>(result.text);
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];

    const findings: StructuredSessionFinding[] = rawFindings.map((f, i) => {
      let tStart = Number((f as StructuredSessionFinding).tStartMs);
      let tEnd = Number((f as StructuredSessionFinding).tEndMs);
      if (!Number.isFinite(tStart)) tStart = 0;
      if (!Number.isFinite(tEnd) || tEnd <= tStart) {
        // Evenly partition when the model omits times.
        const n = Math.max(1, rawFindings.length);
        const span = Math.max(1, durationMs || 1000);
        tStart = Math.round((i / n) * span);
        tEnd = Math.round(((i + 1) / n) * span);
      }
      if (durationMs > 0) {
        tStart = Math.max(0, Math.min(durationMs, tStart));
        tEnd = Math.max(tStart + 1, Math.min(durationMs, tEnd));
      }
      const mid = segmentMidMs(tStart, tEnd);
      return {
        label:
          typeof f.label === "string" && f.label.trim()
            ? f.label.trim()
            : `Finding ${i + 1}`,
        description: typeof f.description === "string" ? f.description : "",
        teachingPoints: Array.isArray(f.teachingPoints)
          ? f.teachingPoints.filter((p): p is string => typeof p === "string")
          : [],
        tStartMs: tStart,
        tEndMs: tEnd,
        suggestedMarker: markerNearTime(track, mid) ?? undefined,
        suggestedSliceIndex: sliceNearTime(track, mid) ?? undefined,
      };
    });

    const session: StructuredSession = {
      transcript:
        typeof parsed.transcript === "string" && parsed.transcript.trim()
          ? parsed.transcript.trim()
          : transcriptHint,
      findings,
    };

    return NextResponse.json(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
