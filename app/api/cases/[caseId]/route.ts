import { learnerCaseProjection } from "@/lib/exam/projection";
import { hasActiveExam } from "@/lib/exam/access";
// GET /api/cases/[caseId] -> single case (draft hidden unless author+)

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, getSession } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { getCaseForOrg } from "@/lib/cases";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  const orgId = await activeOrgId();
  const data = await getCaseForOrg(orgId, params.caseId);
  if (!data) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  if (data.status !== "published") {
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

  if (await hasActiveExam(params.caseId)) return NextResponse.json(learnerCaseProjection(data), { headers: { "Cache-Control": "private, no-store" } });
  return NextResponse.json(data);
}
