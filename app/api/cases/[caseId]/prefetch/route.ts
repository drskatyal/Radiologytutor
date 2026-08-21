// GET /api/cases/[caseId]/prefetch -> the prefetch manifest for a case.
//
// Returns the ordered series UIDs + ordered instance refs the case's findings
// will need, so the client can warm the /api/dicomweb cache (idle/low-priority)
// for an instant case open. Imaging metadata is resolved server-side via
// lib/orthanc.ts; the manifest is sparse (hasImaging:false) when Orthanc isn't
// configured, so the client still degrades gracefully.

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
