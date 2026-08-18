// Admin patient-chronology API (org-scoped).
//
//   GET /api/admin/patients/[patientId]/studies
//     -> the patient's studies ordered by studyDate (oldest "prior" first).

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import { getPatient, listStudiesChronological } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { patientId: string } }
) {
  try {
    const orgId = await requireAdminOrg();
    const patient = await getPatient(orgId, params.patientId);
    if (!patient) {
      return NextResponse.json({ error: "Patient not found." }, { status: 404 });
    }
    const studies = await listStudiesChronological(orgId, params.patientId);
    return NextResponse.json({ patient, studies });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}
