// GET /api/cases/[caseId]/series -> the case's series rail (CaseSeries[]).
//
// Resolves every series the case can show (across its studies) from Orthanc via
// lib/orthanc.ts, ordered finding-first. Returns `{ series: [], hasImaging }`.
// When imaging can't be resolved (Orthanc off / study missing) `series` is
// empty and `hasImaging` is false, so the client falls back to the bundled
// single-series sample. Used by the author capture surface to show the same
// SeriesNavigator the student sees (the student page resolves this server-side).

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, getSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { getCaseForOrg } from "@/lib/cases";
import { resolveCaseSeries } from "@/lib/prefetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WADO_RS_ROOT = "/api/dicomweb";

export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  const orgId = await activeOrgId();
  const c = await getCaseForOrg(orgId, params.caseId);
  if (!c) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  if (c.status !== "published") {
    const session = await getSession();
    const canSeeDraft =
      session &&
      canAccessOrgResource({
        platformRole: session.user.platformRole,
        membershipRole: session.user.membershipRole,
        need: "author",
      });
    if (!canSeeDraft) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }
  }

  const series = await resolveCaseSeries(params.caseId, orgId, WADO_RS_ROOT);
  return NextResponse.json({
    series: series ?? [],
    hasImaging: !!series && series.length > 0,
  });
}
