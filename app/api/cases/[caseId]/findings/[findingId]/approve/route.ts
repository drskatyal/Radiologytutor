import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireRole } from "@/lib/auth";
import { approve } from "@/lib/cases";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: { caseId: string; findingId: string } }) {
  try {
    const user = await requireRole("author");
    const { version, contentHash } = await req.json();
    if (!Number.isInteger(version) || version < 1 || typeof contentHash !== "string") return NextResponse.json({ error: "version and contentHash are required" }, { status: 400 });
    return NextResponse.json(await approve(user.activeOrgId, params.caseId, params.findingId, version, contentHash, user));
  } catch (err) {
    return jsonAuthError(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : "Approval unavailable" }, { status: Number((err as { status?: number })?.status) || 500 });
  }
}
