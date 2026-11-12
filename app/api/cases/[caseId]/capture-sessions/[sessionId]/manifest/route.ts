import { NextRequest, NextResponse } from "next/server";
import { requireAuthorOrg } from "@/lib/auth";
import { captureSession, completeCapture, reviewCapture, startCapture } from "@/lib/journal/storage";
import { captureHttpError } from "@/lib/journal/http";
import { CaptureError } from "@/lib/journal/manifest";
export const runtime = "nodejs";
type Context = { params: { caseId: string; sessionId: string } };
export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const orgId = await requireAuthorOrg();
    return NextResponse.json((await captureSession(orgId, params.caseId, params.sessionId)).manifest, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return captureHttpError(error); }
}
export async function POST(req: NextRequest, { params }: Context) {
  try {
    const orgId = await requireAuthorOrg();
    const body = await req.json();
    if (body.action === "start") return NextResponse.json(await startCapture(orgId, params.caseId, params.sessionId));
    if (body.action === "complete") return NextResponse.json(await completeCapture(orgId, params.caseId, params.sessionId, body.manifest));
    if (body.action === "review") return NextResponse.json(await reviewCapture(orgId, params.caseId, params.sessionId, body.review));
    throw new CaptureError("Unknown capture operation");
  } catch (error) { return captureHttpError(error); }
}
