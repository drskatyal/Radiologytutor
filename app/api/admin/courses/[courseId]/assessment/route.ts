// Course post-test authoring (org-scoped, author+).
//
//   GET    /api/admin/courses/[courseId]/assessment -> { assessment | null, cases }
//   PUT    /api/admin/courses/[courseId]/assessment -> validate + save, returns the assessment
//   DELETE /api/admin/courses/[courseId]/assessment -> remove the post-test
//
// `cases` is what the editor needs to build questions: the course's cases in
// order, each with its findings (id, label, whether it has a marker to click).
// Click targets are resolved from the authored marker on save — never posted.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import {
  deleteAssessmentForCourse,
  getAssessmentForCourse,
  getCasesByIds,
  getCourse,
  saveAssessmentForCourse,
} from "@/lib/cases";
import { validateAssessmentDraft, type DraftCaseContext } from "@/lib/assessmentDraft";
import type { Course } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function courseCases(orgId: string, course: Course): Promise<DraftCaseContext[]> {
  const cases = await getCasesByIds(orgId, course.caseIds);
  return cases.map((c) => ({
    caseId: c.caseId,
    title: c.title,
    findings: c.findings
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((f) => ({ id: f.id, label: f.label, marker: f.marker })),
  }));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { courseId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const course = await getCourse(orgId, params.courseId);
    if (!course) return NextResponse.json({ error: "Course not found." }, { status: 404 });
    const [assessment, cases] = await Promise.all([
      getAssessmentForCourse(orgId, course.id),
      courseCases(orgId, course),
    ]);
    return NextResponse.json({
      assessment,
      cases: cases.map((c) => ({
        caseId: c.caseId,
        title: c.title,
        findings: c.findings.map((f) => ({
          id: f.id,
          label: f.label,
          hasMarker: Boolean(f.marker),
        })),
      })),
    });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    console.error("[api/admin/courses/assessment] GET", err);
    return NextResponse.json({ error: "Couldn't load the post-test." }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { courseId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const course = await getCourse(orgId, params.courseId);
    if (!course) return NextResponse.json({ error: "Course not found." }, { status: 404 });
    const body = await req.json().catch(() => null);
    const cases = await courseCases(orgId, course);
    let n = 0;
    const stamp = Date.now().toString(36);
    const result = validateAssessmentDraft(body, cases, () => `q_${stamp}_${++n}`);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.errors[0], errors: result.errors },
        { status: 400 }
      );
    }
    const assessment = await saveAssessmentForCourse(orgId, course.id, result.value);
    return NextResponse.json({ assessment });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    console.error("[api/admin/courses/assessment] PUT", err);
    return NextResponse.json({ error: "Couldn't save the post-test." }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { courseId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const course = await getCourse(orgId, params.courseId);
    if (!course) return NextResponse.json({ error: "Course not found." }, { status: 404 });
    await deleteAssessmentForCourse(orgId, course.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    console.error("[api/admin/courses/assessment] DELETE", err);
    return NextResponse.json({ error: "Couldn't delete the post-test." }, { status: 500 });
  }
}
