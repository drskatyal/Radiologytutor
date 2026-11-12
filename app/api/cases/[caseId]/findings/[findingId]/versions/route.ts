import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireRole } from "@/lib/auth";
import { createVersion, getCaseForOrg } from "@/lib/cases";
export const runtime = "nodejs";
type Context = { params: { caseId: string; findingId: string } };
function error(err: unknown) {
  return jsonAuthError(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : "Version unavailable" }, { status: Number((err as { status?: number })?.status) || 500 });
}
export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const user = await requireRole("author");
    const data = await getCaseForOrg(user.activeOrgId, params.caseId);
    if (!data?.findings.some(f => f.id === params.findingId)) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
    return NextResponse.json(data.findingVersions?.filter(v => v.findingId === params.findingId) ?? []);
  } catch (err) { return error(err); }
}
export async function POST(req: NextRequest, { params }: Context) {
  try {
    const user = await requireRole("author");
    const { patch, expectedVersion } = await req.json();
    if (!patch || typeof patch !== "object" || !Number.isInteger(expectedVersion) || expectedVersion < 1) return NextResponse.json({ error: "patch and expectedVersion are required" }, { status: 400 });
    return NextResponse.json(await createVersion(user.activeOrgId, params.caseId, params.findingId, patch, { expectedVersion, userId: user.id }));
  } catch (err) { return error(err); }
}
