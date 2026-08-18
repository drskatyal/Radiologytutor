// GET  /api/certificates  -> list certificates for the signed-in user
// POST /api/certificates  -> issue { courseId } when progress is 100%

import { NextRequest, NextResponse } from "next/server";
import { activeOrgId, jsonAuthError, requireSession } from "@/lib/auth";
import { issueCertificate, listCertificatesForUser } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const certificates = await listCertificatesForUser(session.id);
    return NextResponse.json({ certificates });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const orgId = await activeOrgId();
    const body = (await req.json()) as { courseId?: string };
    const courseId = body.courseId?.trim();
    if (!courseId) {
      return NextResponse.json({ error: "courseId is required." }, { status: 400 });
    }

    const certificate = await issueCertificate(
      session.id,
      orgId,
      courseId,
      session.name ?? session.email
    );
    return NextResponse.json({ certificate });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status =
      message.includes("100%") || message.includes("assessment") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
