// Admin patients API (org-scoped).
//
//   GET  /api/admin/patients  -> this org's patients
//   POST /api/admin/patients  -> create a patient { displayName }

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import { listPatients, createPatient } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const orgId = await requireAdminOrg();
    const patients = await listPatients(orgId);
    return NextResponse.json({ patients });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAdminOrg();
    const body = (await req.json()) as { displayName?: string };
    const displayName = (body.displayName ?? "").trim();
    if (!displayName) {
      return NextResponse.json({ error: "Patient name is required." }, { status: 400 });
    }
    const patient = await createPatient(orgId, { displayName });
    return NextResponse.json({ patient });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
