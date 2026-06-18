// Admin cases API (org-scoped). The client never imports lib/cases directly.
//
//   GET  /api/admin/cases   -> list this org's cases enriched with patient name
//                              and study/finding counts, for the admin console.
//   POST /api/admin/cases   -> create a case in one shot: optionally create its
//                              Patient + Study(ies) from an upload, link the
//                              studies (role/order), and create the Case.
//
// orgId is a seam: derived from DEFAULT_ORG_ID until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_ORG_ID,
  listCasesForOrg,
  listPatients,
  createCaseForOrg,
  createPatient,
  getPatient,
  createStudy,
  getStudyByUID,
} from "@/lib/cases";
import type { Case, CaseStudyRef, CaseStatus, Patient, Study } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

/** A case plus the denormalized bits the admin list renders. */
export interface AdminCaseRow extends Case {
  patientName?: string;
  studyCount: number;
  findingCount: number;
}

export async function GET() {
  const [cases, patients] = await Promise.all([
    listCasesForOrg(ORG),
    listPatients(ORG),
  ]);
  const patientById = new Map(patients.map((p) => [p.id, p]));

  const rows: AdminCaseRow[] = cases.map((c) => ({
    ...c,
    patientName: c.patientId ? patientById.get(c.patientId)?.displayName : undefined,
    studyCount: c.studyRefs?.length ?? 0,
    findingCount: c.findings.length,
  }));

  return NextResponse.json({ cases: rows });
}

/** A study to create + link as part of creating a case. */
interface StudyInput {
  studyInstanceUID: string;
  seriesInstanceUIDs?: string[];
  studyDate?: string;
  modality?: string;
  description?: string;
  orthancStudyId?: string;
  /** Series this case actually uses (empty = all of the study's series). */
  caseSeriesInstanceUIDs?: string[];
  role?: CaseStudyRef["role"];
}

interface CreateCaseBody {
  title?: string;
  modality?: string;
  specialty?: string;
  status?: CaseStatus;
  /** Existing patient to attach to, or… */
  patientId?: string;
  /** …a new patient to create. */
  patientName?: string;
  /** Studies to create under the patient and link to the case. */
  studies?: StudyInput[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CreateCaseBody;
    const title = (body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ error: "Title is required." }, { status: 400 });
    }
    const modality = (body.modality ?? "").trim() || "CT";

    // 1. Resolve / create the patient.
    let patient: Patient | null = null;
    if (body.patientId) {
      patient = await getPatient(ORG, body.patientId);
      if (!patient) {
        return NextResponse.json({ error: "Patient not found." }, { status: 404 });
      }
    } else if (body.patientName && body.patientName.trim()) {
      patient = await createPatient(ORG, { displayName: body.patientName.trim() });
    }

    // 2. Create the studies under the patient (deduped by StudyInstanceUID).
    const studyRefs: CaseStudyRef[] = [];
    const createdStudies: Study[] = [];
    if (patient && body.studies?.length) {
      let order = 0;
      for (const s of body.studies) {
        if (!s.studyInstanceUID) continue;
        let study = await getStudyByUID(ORG, s.studyInstanceUID);
        if (!study) {
          study = await createStudy(ORG, {
            patientId: patient.id,
            studyInstanceUID: s.studyInstanceUID,
            studyDate: s.studyDate,
            modality: s.modality,
            description: s.description,
            orthancStudyId: s.orthancStudyId,
            seriesInstanceUIDs: s.seriesInstanceUIDs ?? [],
          });
        }
        createdStudies.push(study);
        studyRefs.push({
          studyInstanceUID: s.studyInstanceUID,
          seriesInstanceUIDs: s.caseSeriesInstanceUIDs ?? [],
          role: s.role ?? (order === 0 ? "current" : "prior"),
          order: order++,
        });
      }
    }

    // 3. Create the case. Self-hosted Cornerstone viewer is the base; the case's
    //    studyRefs carry the study/series identity the viewer loads.
    const created = await createCaseForOrg(ORG, {
      title,
      modality,
      specialty: body.specialty?.trim() || undefined,
      status: body.status ?? "draft",
      pacsbinBaseUrl: "/cornerstone",
      patientId: patient?.id,
      studyRefs: studyRefs.length ? studyRefs : undefined,
    });

    return NextResponse.json({ case: created, patient, studies: createdStudies });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
