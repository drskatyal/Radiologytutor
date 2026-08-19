// GET /api/assessments?courseId=…  → public assessment (no answer keys) + best attempt

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import {
  getBestAttemptForUserAssessment,
  getPublicAssessmentForCourse,
} from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    const orgId = await activeOrgId();
    const courseId = req.nextUrl.searchParams.get("courseId")?.trim();
    if (!courseId) {
      return NextResponse.json({ error: "courseId is required." }, { status: 400 });
    }

    const assessment = await getPublicAssessmentForCourse(orgId, courseId);
    if (!assessment) {
      return NextResponse.json({ assessment: null, bestAttempt: null });
    }

    const bestAttempt = await getBestAttemptForUserAssessment(session.id, assessment.id);
    return NextResponse.json({ assessment, bestAttempt });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
