// POST /api/cases/[caseId]/capture-sessions → persist a continuous demonstration

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { appendCaptureSession } from "@/lib/cases";
import type { CaptureSession } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const body = (await req.json()) as Partial<CaptureSession>;
    if (!body.id || !body.track || body.durationMs == null || !body.createdAt) {
      return NextResponse.json(
        { error: "id, track, durationMs, and createdAt are required" },
        { status: 400 }
      );
    }
    const session: CaptureSession = {
      id: body.id,
      durationMs: body.durationMs,
      track: body.track,
      audioUrl: body.audioUrl,
      transcript: body.transcript,
      createdAt: body.createdAt,
    };
    const updated = await appendCaptureSession(orgId, params.caseId, session);
    return NextResponse.json(updated);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
