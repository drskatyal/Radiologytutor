// GET  /api/progress  -> list progress for the signed-in user
// POST /api/progress  -> upsert progress { courseId, caseId?, markComplete?, lastOpenedCaseId? }

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { listProgressForUser, upsertProgress } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const progress = await listProgressForUser(session.id);
    return NextResponse.json({ progress });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const orgId = await activeOrgId();
    const body = (await req.json()) as {
      courseId?: string;
      caseId?: string;
      markComplete?: boolean;
      lastOpenedCaseId?: string;
    };
    const courseId = body.courseId?.trim();
    if (!courseId) {
      return NextResponse.json({ error: "courseId is required." }, { status: 400 });
    }

    const progress = await upsertProgress({
      userId: session.id,
      orgId,
      courseId,
      caseId: body.caseId?.trim(),
      markComplete: body.markComplete,
      lastOpenedCaseId: body.lastOpenedCaseId?.trim(),
    });
    return NextResponse.json({ progress });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
