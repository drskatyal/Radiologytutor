// Admin studies API (org-scoped).
//
//   POST /api/admin/studies  -> create (or return existing) a Study under a
//     patient, from an uploaded DICOM study. Deduped by StudyInstanceUID.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import { getPatient, createStudy, getStudyByUID } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateStudyBody {
  patientId?: string;
  studyInstanceUID?: string;
  studyDate?: string;
  modality?: string;
  description?: string;
  orthancStudyId?: string;
  seriesInstanceUIDs?: string[];
}

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAdminOrg();
    const body = (await req.json()) as CreateStudyBody;
    if (!body.patientId || !body.studyInstanceUID) {
      return NextResponse.json(
        { error: "patientId and studyInstanceUID are required." },
        { status: 400 }
      );
    }
    const patient = await getPatient(orgId, body.patientId);
    if (!patient) {
      return NextResponse.json({ error: "Patient not found." }, { status: 404 });
    }

    const existing = await getStudyByUID(orgId, body.studyInstanceUID);
    if (existing) {
      return NextResponse.json({ study: existing, created: false });
    }

    const study = await createStudy(orgId, {
      patientId: body.patientId,
      studyInstanceUID: body.studyInstanceUID,
      studyDate: body.studyDate,
      modality: body.modality,
      description: body.description,
      orthancStudyId: body.orthancStudyId,
      seriesInstanceUIDs: body.seriesInstanceUIDs ?? [],
    });
    return NextResponse.json({ study, created: true });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
