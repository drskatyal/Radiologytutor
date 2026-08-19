// GET  /api/cases        -> list org cases (published-only for anonymous)
// POST /api/cases        -> create a case { caseId, title, modality, pacsbinBaseUrl }

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, getSession, jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { canAccessOrgResource } from "@/lib/authRoles";
import { listCasesForOrg, createCaseForOrg } from "@/lib/cases";
import { parseBaseUrl } from "@/lib/pacsbinUrl";

export const runtime = "nodejs";

export async function GET() {
  const orgId = await activeOrgId();
  const session = await getSession();
  const canSeeAll = session
    ? canAccessOrgResource({
        platformRole: session.user.platformRole,
        membershipRole: session.user.membershipRole,
        need: "author",
      })
    : false;
  const cases = await listCasesForOrg(orgId, canSeeAll ? {} : { status: "published" });
  return NextResponse.json(cases);
}

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAuthorOrg();
    const body = await req.json();
    const { caseId, title, modality, pacsbinBaseUrl } = body ?? {};
    if (!caseId || !title || !pacsbinBaseUrl) {
      return NextResponse.json(
        { error: "caseId, title and pacsbinBaseUrl are required" },
        { status: 400 }
      );
    }
    const created = await createCaseForOrg(orgId, {
      caseId: String(caseId),
      title: String(title),
      modality: String(modality ?? "MR"),
      pacsbinBaseUrl: parseBaseUrl(String(pacsbinBaseUrl)),
    });
    return NextResponse.json(created);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
