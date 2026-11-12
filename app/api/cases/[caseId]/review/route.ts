import { NextRequest, NextResponse } from "next/server";
import { requireRole, jsonAuthError } from "@/lib/auth";
import { loadCaseReview } from "@/lib/review/server";
export const runtime = "nodejs";
export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const user = await requireRole("author");
    return NextResponse.json(await loadCaseReview(user.activeOrgId, params.caseId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return jsonAuthError(err) ?? NextResponse.json({ error: "Finding review unavailable. Reload to retry." }, { status: Number((err as { status?: number })?.status) || 500 });
  }
}
