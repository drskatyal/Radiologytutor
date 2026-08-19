// GET /api/certificates/[id] -> one certificate (owner only)

import { NextResponse } from "next/server";
import { jsonAuthError, requireSession } from "@/lib/auth";
import { getCertificate } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requireSession();
    const certificate = await getCertificate(params.id);
    if (!certificate) {
      return NextResponse.json({ error: "Certificate not found." }, { status: 404 });
    }
    if (certificate.userId !== session.id) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ certificate });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
