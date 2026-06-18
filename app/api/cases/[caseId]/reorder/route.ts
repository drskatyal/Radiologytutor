// POST /api/cases/[caseId]/reorder -> { orderedIds: string[] }

import { NextRequest, NextResponse } from "next/server";
import { reorderFindings } from "@/lib/cases";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const { orderedIds } = await req.json();
    if (!Array.isArray(orderedIds)) {
      return NextResponse.json({ error: "orderedIds[] is required" }, { status: 400 });
    }
    const updated = await reorderFindings(params.caseId, orderedIds.map(String));
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
