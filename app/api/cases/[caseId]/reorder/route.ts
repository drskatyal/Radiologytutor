// POST /api/cases/[caseId]/reorder -> { orderedIds: string[] }

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { reorderFindingsScoped } from "@/lib/cases";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const orgId = await requireAuthorOrg();
    const { orderedIds } = await req.json();
    if (!Array.isArray(orderedIds)) {
      return NextResponse.json({ error: "orderedIds[] is required" }, { status: 400 });
    }
    const updated = await reorderFindingsScoped(
      orgId,
      params.caseId,
      orderedIds.map(String)
    );
    return NextResponse.json(updated);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
