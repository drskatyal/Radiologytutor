// Admin single-case API (org-scoped).
//
//   GET    /api/admin/cases/[caseId]  -> case + its patient + chronological studies
//   PATCH  /api/admin/cases/[caseId]  -> update metadata (title/modality/specialty/
//                                        status) and/or study links (studyRefs)
//   DELETE /api/admin/cases/[caseId]  -> delete the case
//
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_ORG_ID,
  getCaseForOrg,
  getPatient,
  listStudiesChronological,
  updateCaseForOrg,
  deleteCaseForOrg,
} from "@/lib/cases";
import type { CaseStatus, CaseStudyRef } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

export async function GET(
  _req: NextRequest,
  { params }: { params: { caseId: string } }
) {
  const c = await getCaseForOrg(ORG, params.caseId);
  if (!c) return NextResponse.json({ error: "Case not found." }, { status: 404 });
  const patient = c.patientId ? await getPatient(ORG, c.patientId) : null;
  const studies = c.patientId ? await listStudiesChronological(ORG, c.patientId) : [];
  return NextResponse.json({ case: c, patient, studies });
}

interface PatchBody {
  title?: string;
  modality?: string;
  specialty?: string | null;
  status?: CaseStatus;
  studyRefs?: CaseStudyRef[];
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const body = (await req.json()) as PatchBody;
    const patch: Parameters<typeof updateCaseForOrg>[2] = {};
    if (typeof body.title === "string") {
      if (!body.title.trim()) {
        return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
      }
      patch.title = body.title.trim();
    }
    if (typeof body.modality === "string") patch.modality = body.modality.trim() || "CT";
    if (body.specialty !== undefined) {
      patch.specialty = body.specialty?.trim() || undefined;
    }
    if (body.status === "draft" || body.status === "published") {
      patch.status = body.status;
    }
    if (Array.isArray(body.studyRefs)) patch.studyRefs = body.studyRefs;

    const updated = await updateCaseForOrg(ORG, params.caseId, patch);
    if (!updated) {
      return NextResponse.json({ error: "Case not found." }, { status: 404 });
    }
    return NextResponse.json({ case: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { caseId: string } }
) {
  const ok = await deleteCaseForOrg(ORG, params.caseId);
  if (!ok) return NextResponse.json({ error: "Case not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
