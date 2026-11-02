// Case share links. Teachers mint, rotate, and revoke. The token itself is
// the secret; this route never accepts an orgId from the client.
//
//   GET    /api/cases/:caseId/share          → the live link, or { share: null }
//   POST   /api/cases/:caseId/share          → create if missing (idempotent)
//   POST   /api/cases/:caseId/share {rotate} → revoke the live link and mint one
//   DELETE /api/cases/:caseId/share          → revoke

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireRole } from "@/lib/auth";
import {
  createCaseShare,
  getCaseForOrg,
  listCaseShares,
  revokeCaseShares,
  rotateCaseShare,
} from "@/lib/cases";
import { activeShare, sharePath } from "@/lib/caseShare";
import type { CaseShare } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicShare(share: CaseShare) {
  return {
    token: share.id,
    path: sharePath(share.id),
    createdAt: share.createdAt,
  };
}

async function authorCase(caseId: string) {
  const user = await requireRole("author");
  const caseData = await getCaseForOrg(user.activeOrgId, caseId);
  return { user, caseData, orgId: user.activeOrgId };
}

export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const { caseData, orgId } = await authorCase(params.caseId);
    if (!caseData) return NextResponse.json({ error: "Case not found" }, { status: 404 });
    const share = activeShare(await listCaseShares(orgId, params.caseId));
    return NextResponse.json({ share: share ? publicShare(share) : null });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const { user, caseData, orgId } = await authorCase(params.caseId);
    if (!caseData) return NextResponse.json({ error: "Case not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { rotate?: boolean };
    const share = body.rotate
      ? await rotateCaseShare(orgId, params.caseId, user.id)
      : await createCaseShare(orgId, params.caseId, user.id);
    return NextResponse.json({ share: publicShare(share) });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const { caseData, orgId } = await authorCase(params.caseId);
    if (!caseData) return NextResponse.json({ error: "Case not found" }, { status: 404 });
    const revoked = await revokeCaseShares(orgId, params.caseId);
    return NextResponse.json({ ok: true, revoked });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}
