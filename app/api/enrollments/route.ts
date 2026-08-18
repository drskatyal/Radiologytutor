// GET  /api/enrollments  -> list enrollments for the signed-in user
// POST /api/enrollments  -> enroll in a course { courseId }

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import {
  createEnrollment,
  getCourse,
  listEnrollmentsForUser,
} from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const enrollments = await listEnrollmentsForUser(session.id);
    return NextResponse.json({ enrollments });
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
    const body = (await req.json()) as { courseId?: string };
    const courseId = body.courseId?.trim();
    if (!courseId) {
      return NextResponse.json({ error: "courseId is required." }, { status: 400 });
    }

    const course = await getCourse(orgId, courseId);
    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const enrollment = await createEnrollment({
      userId: session.id,
      orgId,
      courseId,
      source: "free",
    });
    return NextResponse.json({ enrollment });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
