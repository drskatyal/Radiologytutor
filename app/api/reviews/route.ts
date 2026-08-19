// GET  /api/reviews?courseId= -> { reviews, average, count }
// POST /api/reviews          -> { courseId, rating, body? }

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { createReview, getCourse, listReviewsForCourse } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const orgId = await activeOrgId();
    const courseId = req.nextUrl.searchParams.get("courseId")?.trim();
    if (!courseId) {
      return NextResponse.json({ error: "courseId is required." }, { status: 400 });
    }

    const summary = await listReviewsForCourse(orgId, courseId);
    return NextResponse.json(summary);
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
      rating?: number;
      body?: string;
    };
    const courseId = body.courseId?.trim();
    if (!courseId) {
      return NextResponse.json({ error: "courseId is required." }, { status: 400 });
    }
    if (typeof body.rating !== "number") {
      return NextResponse.json({ error: "rating is required." }, { status: 400 });
    }

    const course = await getCourse(orgId, courseId);
    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const review = await createReview({
      userId: session.id,
      orgId,
      courseId,
      rating: body.rating,
      body: body.body,
      authorName: session.name ?? session.email,
    });
    const summary = await listReviewsForCourse(orgId, courseId);
    return NextResponse.json({ review, ...summary });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
