// GET /api/dicom-cdn/manifest?study={StudyInstanceUID}&series={SeriesInstanceUID}
//
// The viewer's first question on opening a series: "is there a converted
// bundle, and how do I fetch it?" Same gate as /api/dicomweb
// (lib/studyAccess.ts) — a session whose org owns the study, or a share cookie
// naming it. The answer carries a short-lived signed Cloud CDN prefix (or the
// same-origin proxy base) for exactly this series. `available: false` is a
// normal answer and the viewer stays on DICOMweb; when conversion is on, the
// first such answer also queues the conversion for the next reader.
//
// Never cached by the browser or a shared cache: the signature expires.

import { NextRequest, NextResponse } from "next/server";
import { isDicomUid } from "@/lib/dicomCdn/format";
import { seriesManifest } from "@/lib/dicomCdn/manifest";
import { authorizeStudyRead } from "@/lib/studyAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const study = req.nextUrl.searchParams.get("study")?.trim() ?? "";
  const series = req.nextUrl.searchParams.get("series")?.trim() ?? "";
  if (!isDicomUid(study) || !isDicomUid(series)) {
    return NextResponse.json({ error: "study and series must be DICOM UIDs" }, { status: 400, headers: NO_STORE });
  }
  const access = await authorizeStudyRead(req, study);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 401 ? "Sign in to view this study." : "Study not found." },
      { status: access.status, headers: NO_STORE }
    );
  }
  try {
    return NextResponse.json(await seriesManifest(study, series), { headers: NO_STORE });
  } catch (e) {
    console.warn("[dicom-cdn] manifest failed", { series, error: e instanceof Error ? e.message : String(e) });
    // Degrade to DICOMweb rather than fail the viewer.
    return NextResponse.json({ available: false, reason: "not-converted" }, { headers: NO_STORE });
  }
}
