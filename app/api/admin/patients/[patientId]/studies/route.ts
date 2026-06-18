// Admin patient-chronology API (org-scoped).
//
//   GET /api/admin/patients/[patientId]/studies
//     -> the patient's studies ordered by studyDate (oldest "prior" first,
//        newest "current" last) so the UI can lay out prior vs current.
//
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORG_ID, getPatient, listStudiesChronological } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

export async function GET(
  _req: NextRequest,
  { params }: { params: { patientId: string } }
) {
  const patient = await getPatient(ORG, params.patientId);
  if (!patient) {
    return NextResponse.json({ error: "Patient not found." }, { status: 404 });
  }
  const studies = await listStudiesChronological(ORG, params.patientId);
  return NextResponse.json({ patient, studies });
}
