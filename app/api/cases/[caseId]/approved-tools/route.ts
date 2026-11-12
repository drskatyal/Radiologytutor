import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { hasActiveExam } from "@/lib/exam/access";
import { getCaseForOrg } from "@/lib/cases";
import { loadApprovedToolContext } from "@/lib/harness/approvedToolContext";
import { resolveApprovedTool } from "@/lib/harness/approvedTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Live tool requests and REST execution revalidate current approval at this boundary. */
async function handle(req: NextRequest, caseId: string, validate: boolean) {
  try {
    await requireSession();
    if (await hasActiveExam()) return NextResponse.json({ error: "Teaching tools unavailable during examination" }, { status: 403 });
    const orgId = await activeOrgId();
    const data = await getCaseForOrg(orgId, caseId);
    if (!data || data.status !== "published") return NextResponse.json({ error: "Case not found" }, { status: 404 });
    const context = await loadApprovedToolContext(data, undefined, () => getCaseForOrg(orgId, caseId));
    if (!validate) return NextResponse.json(context, { headers: { "Cache-Control": "no-store" } });
    const body = await req.json();
    // Client context/counts/geometry are never used, even if supplied alongside the call.
    const action = typeof body?.name === "string" && body.args && typeof body.args === "object"
      ? resolveApprovedTool(body.name, body.args, context) : null;
    if (!action) return NextResponse.json({ error: "Tool target is not currently approved or is outside the series frame range" }, { status: 422 });
    return NextResponse.json({ action }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonAuthError(err) ?? NextResponse.json({ error: "Approved viewer tools unavailable" }, { status: 503 });
  }
}
export function GET(req: NextRequest, { params }: { params: { caseId: string } }) { return handle(req, params.caseId, false); }
export function POST(req: NextRequest, { params }: { params: { caseId: string } }) { return handle(req, params.caseId, true); }
