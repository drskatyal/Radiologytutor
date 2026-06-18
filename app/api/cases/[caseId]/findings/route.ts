// POST /api/cases/[caseId]/findings -> append a finding
// Body: a full Finding (id optional — generated if missing)

import { NextRequest, NextResponse } from "next/server";
import { addFinding } from "@/lib/cases";
import type { Finding } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const body = (await req.json()) as Partial<Finding>;
    if (!body.state || !body.marker) {
      return NextResponse.json(
        { error: "state and marker are required" },
        { status: 400 }
      );
    }
    const finding: Finding = {
      id: body.id || `f${Date.now().toString(36)}`,
      label: body.label || "Untitled finding",
      description: body.description || "",
      teachingPoints: body.teachingPoints || [],
      state: body.state,
      marker: body.marker,
      keyframes: body.keyframes,
      // Self-hosted record/replay: ordered event log + narration audio.
      track: body.track,
      durationMs: body.durationMs,
      order: body.order ?? 0,
    };
    const updated = await addFinding(params.caseId, finding);
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
