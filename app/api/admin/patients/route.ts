// Admin patients API (org-scoped).
//
//   GET  /api/admin/patients  -> this org's patients (for attaching a case to an
//                                existing patient / showing chronology context)
//   POST /api/admin/patients  -> create a patient { displayName }
//
// orgId is a seam (DEFAULT_ORG_ID) until real auth lands (§4a).

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORG_ID, listPatients, createPatient } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

export async function GET() {
  const patients = await listPatients(ORG);
  return NextResponse.json({ patients });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { displayName?: string };
    const displayName = (body.displayName ?? "").trim();
    if (!displayName) {
      return NextResponse.json({ error: "Patient name is required." }, { status: 400 });
    }
    const patient = await createPatient(ORG, { displayName });
    return NextResponse.json({ patient });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
