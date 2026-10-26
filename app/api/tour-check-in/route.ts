// POST /api/tour-check-in
// Body: finding text the student already has (gold, notes, say lines).
// Reply: { source: "model" | "fallback" | "none", checkIn: TourCheckIn | null }
//
// Gemini writes one text MCQ. A missing key, a bad payload, or any error
// returns source "fallback" and checkIn null so the client speaks the
// deterministic question. Coordinates are rejected in lib/tourCheckIn.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireSession } from "@/lib/auth";
import { generate, geminiConfigured, parseJsonLoose } from "@/lib/gemini";
import {
  CHECK_IN_SYSTEM,
  checkInFromModel,
  checkInModelPrompt,
  resolveCheckIn,
  type CheckInSource,
} from "@/lib/tourCheckIn";

export const runtime = "nodejs";

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function clipList(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLen));
  return items.length ? items : undefined;
}

function sourceFromBody(body: Record<string, unknown>): CheckInSource | null {
  const id = clip(body.findingId, 120);
  if (!id) return null;
  const says = clipList(body.says, 12, 500) ?? [];
  return {
    id,
    label: clip(body.label, 200),
    description: clip(body.description, 1500),
    teachingPoints: clipList(body.teachingPoints, 8, 400),
    reportGold: clip(body.reportGold, 1500),
    reportMustMention: clipList(body.reportMustMention, 12, 120),
    teachingGuide: says.length ? { beats: says.map((say) => ({ say })) } : undefined,
  };
}

export async function POST(req: NextRequest) {
  try {
    await requireSession();
    const body = (await req.json()) as Record<string, unknown>;
    const source = sourceFromBody(body);
    if (!source) {
      return NextResponse.json({ error: "findingId is required" }, { status: 400 });
    }

    let model: unknown = null;
    if (geminiConfigured()) {
      try {
        const result = await generate({
          systemInstruction: CHECK_IN_SYSTEM,
          temperature: 0.2,
          jsonOnly: true,
          contents: [{ role: "user", parts: [{ text: checkInModelPrompt(source) }] }],
        });
        model = parseJsonLoose<unknown>(result.text);
      } catch {
        model = null;
      }
    }

    const checkIn = resolveCheckIn(source, model);
    const fromModel = model != null && checkInFromModel(model, source.id) != null;
    return NextResponse.json({
      source: !checkIn ? "none" : fromModel ? "model" : "fallback",
      checkIn,
    });
  } catch (err) {
    const authErr = jsonAuthError(err);
    if (authErr) return authErr;
    return NextResponse.json({ source: "fallback", checkIn: null });
  }
}
