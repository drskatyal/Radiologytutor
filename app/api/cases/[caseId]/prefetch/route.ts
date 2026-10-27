// GET /api/cases/[caseId]/prefetch -> the prefetch manifest for a case.
//
// Returns series order and finding focus only. Instance SOP lists stay empty
// so the case list does not enumerate every slice of every series. The viewer
// prefetches the active series' neighbors after the first frame.

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, getSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { getCaseForOrg } from "@/lib/cases";
import { buildPrefetchManifest } from "@/lib/prefetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const manifest = await buildPrefetchManifest(params.caseId, orgId);
  if (!manifest) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }
  return NextResponse.json(manifest);
}
