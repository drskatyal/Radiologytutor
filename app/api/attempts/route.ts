// POST /api/attempts — submit answers for an assessment; returns graded Attempt

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { submitAttempt } from "@/lib/cases";
import type { LearnerAnswer } from "@/lib/assessmentGrade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const orgId = await activeOrgId();
    const body = (await req.json()) as {
      assessmentId?: string;
      answers?: LearnerAnswer[];
    };
    const assessmentId = body.assessmentId?.trim();
    if (!assessmentId) {
      return NextResponse.json({ error: "assessmentId is required." }, { status: 400 });
    }
    if (!Array.isArray(body.answers)) {
      return NextResponse.json({ error: "answers must be an array." }, { status: 400 });
    }

    const attempt = await submitAttempt({
      userId: session.id,
      orgId,
      assessmentId,
      answers: body.answers,
    });
    return NextResponse.json({ attempt });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
