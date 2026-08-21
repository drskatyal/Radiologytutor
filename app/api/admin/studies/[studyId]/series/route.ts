// Admin study-series API (org-scoped).
//
//   GET /api/admin/studies/[studyId]/series
//     -> compact, cover-ready metadata for each series in a stored Study, read
//        from Orthanc (modality, description, instance count, first SOP UID).
//        Used to pick/repick the series a case teaches from. Degrades to the
//        stored seriesInstanceUIDs (no per-series meta) when Orthanc is off.
//
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { getStudy } from "@/lib/cases";
import {
  orthancConfigured,
  orthancFindStudyByUID,
  orthancStudySeriesMeta,
  type SeriesMeta,
} from "@/lib/orthanc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { studyId: string } }
) {
  let orgId: string;
  try {
    orgId = await requireAuthorOrg();
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
  const study = await getStudy(orgId, params.studyId);
  if (!study) {
    return NextResponse.json({ error: "Study not found." }, { status: 404 });
  }

  // Fallback shape from what we already stored — no Orthanc round-trip needed.
  const fallback: SeriesMeta[] = study.seriesInstanceUIDs.map((uid) => ({
    seriesInstanceUID: uid,
    orthancSeriesId: "",
    instanceCount: 0,
  }));

  if (!orthancConfigured()) {
    return NextResponse.json({ study, series: fallback, hasImaging: false });
  }

  try {
    const orthancStudyId =
      study.orthancStudyId ?? (await orthancFindStudyByUID(study.studyInstanceUID));
    if (!orthancStudyId) {
      return NextResponse.json({ study, series: fallback, hasImaging: false });
    }
    const series = await orthancStudySeriesMeta(orthancStudyId);
    return NextResponse.json({ study, series, hasImaging: true });
  } catch {
    // Best-effort: never fail the editor because imaging metadata is unreachable.
    return NextResponse.json({ study, series: fallback, hasImaging: false });
  }
}
