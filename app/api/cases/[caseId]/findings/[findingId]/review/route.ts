import { NextRequest, NextResponse } from "next/server";
import { requireRole, jsonAuthError } from "@/lib/auth";
import { saveReview } from "@/lib/review/server";
import { FindingConflict } from "@/lib/findingContent";
import { PhiError } from "@/lib/phiGuard";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: { caseId: string; findingId: string } }) {
  try {
    const user = await requireRole("author");
    return NextResponse.json(await saveReview(user.activeOrgId, params.caseId, params.findingId, user.id, await req.json()), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return jsonAuthError(err) ?? NextResponse.json({ error: err instanceof FindingConflict || err instanceof PhiError ? err.message : "Review could not be saved. Your draft is kept." }, { status: Number((err as { status?: number })?.status) || 500 });
  }
}
