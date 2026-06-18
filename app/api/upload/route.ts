// POST /api/upload — accept one or more DICOM files (multipart form-data),
// store them in Orthanc, and return the resulting study/series DICOM UIDs so
// the viewer can load them via the DICOMweb proxy.
//
// NOTE: de-identification is NOT yet wired here. Until it is, upload only
// already-anonymized teaching studies. (Planned: Orthanc anonymize-on-ingest
// + pydicom `deid` for burned-in pixel PHI + a manual review gate.)

import { NextRequest, NextResponse } from "next/server";
import {
  orthancConfigured,
  orthancIngestInstance,
  orthancStudyUIDs,
  orthancSeriesUID,
} from "@/lib/orthanc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SeriesOut {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  description: string;
  instances: number;
}

export async function POST(req: NextRequest) {
  if (!orthancConfigured()) {
    return NextResponse.json(
      { error: "Orthanc backend not configured (set ORTHANC_URL)." },
      { status: 503 }
    );
  }

  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
  }

  // Store each instance; group results by Orthanc study/series id.
  const seriesMap = new Map<string, { studyId: string; count: number }>();
  let stored = 0;
  const errors: string[] = [];

  for (const file of files) {
    try {
      const res = await orthancIngestInstance(await file.arrayBuffer());
      stored++;
      const existing = seriesMap.get(res.ParentSeries);
      if (existing) existing.count++;
      else seriesMap.set(res.ParentSeries, { studyId: res.ParentStudy, count: 1 });
    } catch (e) {
      errors.push(`${file.name}: ${(e as Error).message}`);
    }
  }

  // Resolve DICOM UIDs for each distinct series.
  const series: SeriesOut[] = [];
  const studyCache = new Map<string, { studyInstanceUID: string; description: string }>();
  for (const [seriesId, info] of seriesMap) {
    try {
      let study = studyCache.get(info.studyId);
      if (!study) {
        study = await orthancStudyUIDs(info.studyId);
        studyCache.set(info.studyId, study);
      }
      const seriesInstanceUID = await orthancSeriesUID(seriesId);
      series.push({
        studyInstanceUID: study.studyInstanceUID,
        seriesInstanceUID,
        description: study.description,
        instances: info.count,
      });
    } catch (e) {
      errors.push(`series ${seriesId}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({ stored, series, errors });
}
