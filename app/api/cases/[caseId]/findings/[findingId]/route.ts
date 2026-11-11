// PATCH  /api/cases/[caseId]/findings/[findingId] -> update fields
// DELETE /api/cases/[caseId]/findings/[findingId] -> delete finding

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg, requireSession } from "@/lib/auth";
import { updateFindingScoped, createVersion, deleteFindingScoped } from "@/lib/cases";
import type { Finding } from "@/lib/types";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { caseId: string; findingId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const patch = (await req.json()) as Partial<Finding>;
    const expectedVersion = (patch as Partial<Finding> & { expectedVersion?: number }).expectedVersion;
    const updated = expectedVersion === undefined
      ? await updateFindingScoped(orgId, params.caseId, params.findingId, patch, (await requireSession()).id)
      : await createVersion(orgId, params.caseId, params.findingId, patch, { expectedVersion, userId: (await requireSession()).id });
    return NextResponse.json(updated);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: Number((err as { status?: number }).status) || 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { caseId: string; findingId: string } }
) {
  try {
    const orgId = await requireAuthorOrg();
    const updated = await deleteFindingScoped(orgId, params.caseId, params.findingId);
    return NextResponse.json(updated);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: Number((err as { status?: number }).status) || 500 });
  }
}
