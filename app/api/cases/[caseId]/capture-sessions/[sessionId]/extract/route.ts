import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { captureHttpError } from "@/lib/journal/http";
import { CaptureError } from "@/lib/journal/manifest";
import { commitExtraction, getExtraction, runExtraction } from "@/lib/extract/run";
import type { ExtractionJob } from "@/lib/extract/types";
export const runtime = "nodejs";
type Context = { params: { caseId: string; sessionId: string } };
function response(job: ExtractionJob) {
  const { leaseToken: _lease, leaseExpiresAt: _expiry, baseFindings: _base, ...view } = job;
  return NextResponse.json(view, { status: job.status === "running" ? 202 : job.status === "conflict" ? 409 : job.status === "failed" ? job.errorCode === "PHI_REVIEW_REQUIRED" ? 422 : 503 : 200, headers: { "Cache-Control": "private, no-store" } });
}
export async function GET(req: NextRequest, { params }: Context) {
  try {
    const user = await requireRole("author");
    const job = await getExtraction(user.activeOrgId, params.caseId, params.sessionId, req.nextUrl.searchParams.get("jobId") || undefined);
    if (!job) throw new CaptureError("Extraction job not found", 404);
    return response(job);
  } catch (error) { return captureHttpError(error); }
}
export async function POST(req: NextRequest, { params }: Context) {
  try {
    const user = await requireRole("author");
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["action", "retry", "jobId", "markerDecisions"].includes(key))) throw new CaptureError("Invalid extraction request");
    if (body.retry !== undefined && typeof body.retry !== "boolean") throw new CaptureError("Invalid extraction retry");
    if (body.action === "commit") {
      if (typeof body.jobId !== "string" || !/^[a-f0-9]{64}$/.test(body.jobId)) throw new CaptureError("Invalid extraction job ID");
      return response(await commitExtraction(user.activeOrgId, params.caseId, params.sessionId, body.jobId, user.id));
    }
    if (body.action && body.action !== "extract") throw new CaptureError("Unknown extraction operation");
    return response(await runExtraction(user.activeOrgId, params.caseId, params.sessionId, user.id, { retry: body.retry === true, markerDecisions: body.markerDecisions }));
  } catch (error) { return captureHttpError(error); }
}
