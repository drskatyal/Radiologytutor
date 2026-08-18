// Admin single-case API (org-scoped).
//
//   GET    /api/admin/cases/[caseId]  -> case + its patient + chronological studies
//   PATCH  /api/admin/cases/[caseId]  -> update metadata (title/modality/specialty/
//                                        status) and/or study links (studyRefs)
//   DELETE /api/admin/cases/[caseId]  -> delete the case
//
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import {
  getCaseForOrg,
  getPatient,
  listStudiesChronological,
  updateCaseForOrg,
  deleteCaseForOrg,
} from "@/lib/cases";
import {
  BODY_SYSTEMS,
  DIFFICULTIES,
  type BodySystem,
  type CaseStatus,
  type CaseStudyRef,
  type Difficulty,
} from "@/lib/types";
import { pickPresentDetails } from "../caseDetails";

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
function cleanTags(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const tags = v.map((t) => String(t).trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const ORG = await requireAdminOrg();
    const c = await getCaseForOrg(ORG, params.caseId);
  if (!c) return NextResponse.json({ error: "Case not found." }, { status: 404 });
  const patient = c.patientId ? await getPatient(ORG, c.patientId) : null;
  const studies = c.patientId ? await listStudiesChronological(ORG, c.patientId) : [];
  return NextResponse.json({ case: c, patient, studies });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

interface PatchBody {
  title?: string;
  modality?: string;
  specialty?: string | null;
  status?: CaseStatus;
  studyRefs?: CaseStudyRef[];
  difficulty?: string | null;
  system?: string | null;
  tags?: string[];
  authorId?: string | null;
  // Exam-grade teaching details (applied only when present; see pickPresentDetails).
  clinicalHistory?: string;
  patientAge?: string;
  patientSex?: string;
  technique?: string;
  primaryDiagnosis?: string;
  differentials?: string[];
  targetLevel?: string;
  learningObjectives?: string[];
  discussion?: string;
  references?: string[];
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const ORG = await requireAdminOrg();
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
    if (body.difficulty !== undefined) patch.difficulty = asDifficulty(body.difficulty);
    if (body.system !== undefined) patch.system = asSystem(body.system);
    if (body.tags !== undefined) patch.tags = cleanTags(body.tags);
    if (body.authorId !== undefined) patch.authorId = body.authorId || undefined;
    // Exam-grade teaching details: apply only the keys present in the body so an
    // omitted field is untouched (present-but-blank clears it).
    Object.assign(patch, pickPresentDetails(body as Record<string, unknown>));

    const updated = await updateCaseForOrg(ORG, params.caseId, patch);
    if (!updated) {
      return NextResponse.json({ error: "Case not found." }, { status: 404 });
    }
    return NextResponse.json({ case: updated });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { caseId: string } }
) {
  try {
    const ORG = await requireAdminOrg();
    const ok = await deleteCaseForOrg(ORG, params.caseId);
    if (!ok) return NextResponse.json({ error: "Case not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}
