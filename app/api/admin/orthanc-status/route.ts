// Admin imaging-status API.
//
//   GET /api/admin/orthanc-status -> { configured } — is the DICOM archive
//     wired up at all (ORTHANC_URL set)? The create-case flow checks this up
//     front so it can show a calm "imaging not connected" notice instead of
//     letting an upload fail with a scary error.
//
// This only reports configuration, never credentials, and does no Orthanc
// round-trip (so it stays instant and can't itself error).

import { NextResponse } from "next/server";
import { jsonAuthError, requireAdminOrg } from "@/lib/auth";
import { orthancConfigured } from "@/lib/orthanc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminOrg();
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
  return NextResponse.json({ configured: orthancConfigured() });
}
