// Admin single-course API (org-scoped).
//
//   GET    /api/admin/courses/[courseId]  -> the course
//   PATCH  /api/admin/courses/[courseId]  -> update metadata / ordered caseIds
//   DELETE /api/admin/courses/[courseId]  -> delete the course

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import { getCourse, updateCourse, deleteCourse } from "@/lib/cases";
import {
  BODY_SYSTEMS,
  DIFFICULTIES,
  type BodySystem,
  type CaseStatus,
  type Difficulty,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asSystem(v: unknown): BodySystem | undefined {
  return typeof v === "string" && (BODY_SYSTEMS as string[]).includes(v)
    ? (v as BodySystem)
    : undefined;
}
function asDifficulty(v: unknown): Difficulty | undefined {
  return typeof v === "string" && (DIFFICULTIES as string[]).includes(v)
    ? (v as Difficulty)
    : undefined;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { courseId: string } }
) {
  try {
    const orgId = await requireAdminOrg();
    const course = await getCourse(orgId, params.courseId);
    if (!course) return NextResponse.json({ error: "Course not found." }, { status: 404 });
    return NextResponse.json({ course });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

interface PatchBody {
  title?: string;
  description?: string | null;
  difficulty?: string | null;
  system?: string | null;
  authorId?: string | null;
  caseIds?: string[];
  status?: CaseStatus;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { courseId: string } }
) {
  try {
    const orgId = await requireAdminOrg();
    const body = (await req.json()) as PatchBody;
    const patch: Parameters<typeof updateCourse>[2] = {};
    if (typeof body.title === "string") {
      if (!body.title.trim()) {
        return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
      }
      patch.title = body.title.trim();
    }
    if (body.description !== undefined) patch.description = body.description?.trim() || undefined;
    if (body.difficulty !== undefined) patch.difficulty = asDifficulty(body.difficulty);
    if (body.system !== undefined) patch.system = asSystem(body.system);
    if (body.authorId !== undefined) patch.authorId = body.authorId || undefined;
    if (Array.isArray(body.caseIds)) patch.caseIds = body.caseIds;
    if (body.status === "draft" || body.status === "published") patch.status = body.status;

    const updated = await updateCourse(orgId, params.courseId, patch);
    if (!updated) return NextResponse.json({ error: "Course not found." }, { status: 404 });
    return NextResponse.json({ course: updated });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { courseId: string } }
) {
  try {
    const orgId = await requireAdminOrg();
    const ok = await deleteCourse(orgId, params.courseId);
    if (!ok) return NextResponse.json({ error: "Course not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}
