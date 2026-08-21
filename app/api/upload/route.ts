// POST /api/upload — accept one or more DICOM files (multipart form-data),
// store them in Orthanc, and return the resulting study/series DICOM UIDs (with
// cover-ready metadata) so the create-case flow can group + preview them.
//
// The client uploads in small batches (so a 300-slice study never sends one
// giant request) and may retry just the files that failed. Each response is
// therefore per-batch and per-file: { stored, series[], failed[], skipped[] }.
//
// We are defensive about what arrives:
//   • .zip archives are expanded server-side (a radiologist exporting a study
//     from a PACS often gets a single .zip).
//   • obvious junk (DICOMDIR, .DS_Store, Thumbs.db, images/PDFs) is skipped with
//     a friendly reason rather than failing the whole upload.
//   • files that don't look like DICOM (no "DICM" magic at offset 128) are
//     skipped, not stored.
//
// De-id: orthancIngestInstance runs lib/deid.ts (header identity gate) and
// refuses residual PatientName/ID/DOB/etc. Pixel OCR is not claimed. Upload
// already-anonymized teaching studies; burned-in PHI still needs a later scanner.

import { NextRequest, NextResponse } from "next/server";
import AdmZip from "adm-zip";
import {
  orthancConfigured,
  orthancIngestInstance,
  orthancSeriesMeta,
  orthancGet,
} from "@/lib/orthanc";
import { DeidFailError } from "@/lib/deid";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { upsertDeidReport } from "@/lib/cases";
import type { DeidReport } from "@/lib/deid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cover-ready metadata for one uploaded series (mirrors UploadedSeries). */
interface SeriesOut {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  studyDescription: string;
  seriesDescription?: string;
  modality?: string;
  studyDate?: string;
  orthancStudyId?: string;
  firstInstanceUID?: string;
  instances: number;
}

interface SkippedOut {
  name: string;
  reason: string;
}

/** A single DICOM-looking blob ready to ingest, tagged with its source name. */
interface Candidate {
  name: string;
  bytes: ArrayBuffer;
}

// Names we never try to store — control files and obvious non-image junk.
const JUNK_NAMES = new Set(["dicomdir", ".ds_store", "thumbs.db", "desktop.ini"]);
const NON_DICOM_EXT =
  /\.(jpe?g|png|gif|bmp|tiff?|pdf|txt|xml|html?|json|csv|xlsx?|docx?|mp4|mov|zip)$/i;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Heuristic: does this buffer look like a DICOM Part-10 file? */
function looksLikeDicom(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 132) return false;
  const magic = new Uint8Array(bytes, 128, 4);
  // "DICM" preamble at byte 128 — present on virtually all stored DICOM files.
  return (
    magic[0] === 0x44 && magic[1] === 0x49 && magic[2] === 0x43 && magic[3] === 0x4d
  );
}

/** Classify a named blob: ingest it, or skip it with a reason. */
function classify(name: string, bytes: ArrayBuffer): { skip?: string } {
  const base = baseName(name).toLowerCase();
  if (JUNK_NAMES.has(base)) return { skip: "system file" };
  if (base.startsWith(".")) return { skip: "hidden file" };
  if (NON_DICOM_EXT.test(base)) return { skip: "not a DICOM file" };
  if (!looksLikeDicom(bytes)) return { skip: "not a DICOM file" };
  return {};
}

export async function POST(req: NextRequest) {
  let orgId: string;
  try {
    orgId = await requireAuthorOrg();
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
  if (!orthancConfigured()) {
    return NextResponse.json(
      {
        error:
          "Imaging archive isn't connected yet, so studies can't be uploaded. " +
          "You can still create the case and link imaging later.",
        code: "ORTHANC_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Couldn't read the uploaded files. Please try again." },
      { status: 400 }
    );
  }

  const uploaded = form.getAll("files").filter((f): f is File => f instanceof File);
  if (uploaded.length === 0) {
    return NextResponse.json({ error: "No files were uploaded." }, { status: 400 });
  }

  const skipped: SkippedOut[] = [];
  const candidates: Candidate[] = [];

  // 1. Expand zips and classify every blob. Junk/non-DICOM is reported, not stored.
  for (const file of uploaded) {
    const name = baseName(file.name) || "file";
    if (/\.zip$/i.test(name)) {
      try {
        const zip = new AdmZip(Buffer.from(await file.arrayBuffer()));
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const entryName = baseName(entry.entryName);
          const data = entry.getData();
          const buf = data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength
          ) as ArrayBuffer;
          const { skip } = classify(entryName, buf);
          if (skip) skipped.push({ name: `${name} › ${entryName}`, reason: skip });
          else candidates.push({ name: entryName, bytes: buf });
        }
      } catch {
        skipped.push({ name, reason: "couldn't open zip archive" });
      }
      continue;
    }

    const bytes = await file.arrayBuffer();
    const { skip } = classify(name, bytes);
    if (skip) skipped.push({ name, reason: skip });
    else candidates.push({ name, bytes });
  }

  // 2. Store each DICOM instance; group by Orthanc series id.
  //    Keep the best (passing) de-id report per Orthanc study for persistence.
  const seriesMap = new Map<string, { studyId: string; count: number }>();
  const deidByStudy = new Map<string, DeidReport>();
  let stored = 0;
  const failed: SkippedOut[] = [];

  for (const c of candidates) {
    try {
      const res = await orthancIngestInstance(c.bytes);
      stored++;
      const existing = seriesMap.get(res.ParentSeries);
      if (existing) existing.count++;
      else seriesMap.set(res.ParentSeries, { studyId: res.ParentStudy, count: 1 });
      if (!deidByStudy.has(res.ParentStudy)) {
        deidByStudy.set(res.ParentStudy, res.deidReport);
      }
    } catch (e) {
      failed.push({ name: c.name, reason: friendlyStoreError(e) });
    }
  }

  // 3. Resolve cover-ready metadata for each distinct series.
  const series: SeriesOut[] = [];
  const studyCache = new Map<
    string,
    { studyInstanceUID: string; studyDescription: string; studyDate?: string }
  >();
  for (const [seriesId, info] of seriesMap) {
    try {
      let study = studyCache.get(info.studyId);
      if (!study) {
        study = await studyMeta(info.studyId);
        studyCache.set(info.studyId, study);
        const report = deidByStudy.get(info.studyId);
        if (report) {
          await upsertDeidReport(orgId, {
            ...report,
            studyInstanceUID: study.studyInstanceUID,
            studyId: info.studyId,
          }).catch(() => undefined);
        }
      }
      const meta = await orthancSeriesMeta(seriesId);
      series.push({
        studyInstanceUID: study.studyInstanceUID,
        seriesInstanceUID: meta.seriesInstanceUID,
        studyDescription: study.studyDescription,
        seriesDescription: meta.seriesDescription,
        modality: meta.modality,
        studyDate: study.studyDate,
        orthancStudyId: info.studyId,
        firstInstanceUID: meta.firstInstanceUID,
        // Trust our own per-batch tally over Orthanc's count (which would be
        // global across multiple batches of the same series).
        instances: info.count,
      });
    } catch (e) {
      failed.push({
        name: `series ${seriesId.slice(0, 8)}`,
        reason: friendlyStoreError(e),
      });
    }
  }

  return NextResponse.json({ stored, series, failed, skipped });
}

/** Resolve a study's UID + description + date from its Orthanc id. */
async function studyMeta(orthancStudyId: string): Promise<{
  studyInstanceUID: string;
  studyDescription: string;
  studyDate?: string;
}> {
  const study = await orthancGet<{
    MainDicomTags: {
      StudyInstanceUID: string;
      StudyDescription?: string;
      StudyDate?: string;
    };
    PatientMainDicomTags?: { PatientName?: string };
  }>(`/studies/${orthancStudyId}`);
  const tags = study.MainDicomTags;
  return {
    studyInstanceUID: tags.StudyInstanceUID,
    studyDescription:
      tags.StudyDescription || study.PatientMainDicomTags?.PatientName || "Study",
    studyDate: tags.StudyDate || undefined,
  };
}

/** Turn an Orthanc error into something a radiologist can act on. */
function friendlyStoreError(e: unknown): string {
  if (e instanceof DeidFailError || (e instanceof Error && e.message.startsWith("DEID_FAIL"))) {
    return "this file still has patient identifiers — de-identify the study before upload";
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/-> 4\d\d/.test(msg)) return "not a valid DICOM file";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|timeout/i.test(msg)) {
    return "imaging archive unreachable";
  }
  return "couldn't be stored";
}
