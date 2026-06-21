// GET /api/cases/[caseId]/series -> the case's series rail (CaseSeries[]).
//
// Resolves every series the case can show (across its studies) from Orthanc via
// lib/orthanc.ts, ordered finding-first. Returns `{ series: [], hasImaging }`.
// When imaging can't be resolved (Orthanc off / study missing) `series` is
// empty and `hasImaging` is false, so the client falls back to the bundled
// single-series sample. Used by the author capture surface to show the same
// SeriesNavigator the student sees (the student page resolves this server-side).

import { NextRequest, NextResponse } from "next/server";
import { resolveCaseSeries } from "@/lib/prefetch";
import { DEFAULT_ORG_ID } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WADO_RS_ROOT = "/api/dicomweb";

export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  // orgId is a seam — derived from the (stubbed) session for now.
  const series = await resolveCaseSeries(params.caseId, DEFAULT_ORG_ID, WADO_RS_ROOT);
  return NextResponse.json({
    series: series ?? [],
    hasImaging: !!series && series.length > 0,
  });
}
