// GET    /api/wishlist  -> list wishlist for the signed-in user
// POST   /api/wishlist  -> add { courseId }
// DELETE /api/wishlist?courseId= -> remove

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import {
  addToWishlist,
  getCourse,
  listWishlistForUser,
  removeFromWishlist,
} from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const wishlist = await listWishlistForUser(session.id);
    return NextResponse.json({ wishlist });
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

    const item = await addToWishlist(session.id, orgId, courseId);
    return NextResponse.json({ item });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireSession();
    const courseId = req.nextUrl.searchParams.get("courseId")?.trim();
    if (!courseId) {
      return NextResponse.json({ error: "courseId is required." }, { status: 400 });
    }

    await removeFromWishlist(session.id, courseId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
