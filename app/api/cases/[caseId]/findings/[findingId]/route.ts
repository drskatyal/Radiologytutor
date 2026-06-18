// PATCH  /api/cases/[caseId]/findings/[findingId] -> update fields
// DELETE /api/cases/[caseId]/findings/[findingId] -> delete finding

import { NextRequest, NextResponse } from "next/server";
import { updateFinding, deleteFinding } from "@/lib/cases";
import type { Finding } from "@/lib/types";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { caseId: string; findingId: string } }
) {
  try {
    const patch = (await req.json()) as Partial<Finding>;
    const updated = await updateFinding(params.caseId, params.findingId, patch);
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { caseId: string; findingId: string } }
) {
  try {
    const updated = await deleteFinding(params.caseId, params.findingId);
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
