// Admin studies API (org-scoped).
//
//   POST /api/admin/studies  -> create (or return existing) a Study under a
//     patient, from an uploaded DICOM study. Deduped by StudyInstanceUID so a
//     re-upload of the same study doesn't create duplicates. Used when adding a
//     prior/comparison study to an existing patient.
//
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_ORG_ID,
  getPatient,
  createStudy,
  getStudyByUID,
} from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

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
    const body = (await req.json()) as CreateStudyBody;
    if (!body.patientId || !body.studyInstanceUID) {
      return NextResponse.json(
        { error: "patientId and studyInstanceUID are required." },
        { status: 400 }
      );
    }
    const patient = await getPatient(ORG, body.patientId);
    if (!patient) {
      return NextResponse.json({ error: "Patient not found." }, { status: 404 });
    }

    const existing = await getStudyByUID(ORG, body.studyInstanceUID);
    if (existing) {
      return NextResponse.json({ study: existing, created: false });
    }

    const study = await createStudy(ORG, {
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
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
