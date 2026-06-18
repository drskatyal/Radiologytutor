// GET /api/cases/[caseId]/prefetch -> the prefetch manifest for a case.
//
// Returns the ordered series UIDs + ordered instance refs the case's findings
// will need, so the client can warm the /api/dicomweb cache (idle/low-priority)
// for an instant case open. Imaging metadata is resolved server-side via
// lib/orthanc.ts; the manifest is sparse (hasImaging:false) when Orthanc isn't
// configured, so the client still degrades gracefully.

import { NextRequest, NextResponse } from "next/server";
import { buildPrefetchManifest } from "@/lib/prefetch";
import { DEFAULT_ORG_ID } from "@/lib/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { caseId: string } }) {
  // orgId is a seam — derived from the (stubbed) session for now.
  const manifest = await buildPrefetchManifest(params.caseId, DEFAULT_ORG_ID);
  if (!manifest) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }
  return NextResponse.json(manifest);
}
