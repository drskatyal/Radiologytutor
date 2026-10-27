// GET /api/cases/[caseId]/series -> the case's series rail (CaseSeries[]).
//
// Background rail enrichment. The case page does not wait on this: it renders
// from study/series UIDs already on the case, and the client merges this
// response (descriptions, positive DICOMweb counts) without moving the series
// already on screen. Returns `{ series: [], hasImaging }`. Empty means imaging
// could not be listed, and the client may fall back to the bundled sample
// only when the case itself has no series UIDs.

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
