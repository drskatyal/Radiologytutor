// Classify, de-identify, and STOW one upload batch.
//
// POST /api/upload calls this only after requireAuthorOrg. Each DICOM instance
// is rewritten by lib/teachingDeidentify.ts (identity tags blanked, UIDs
// remapped) before orthancIngestInstance. The gate still refuses residual
// PatientName/ID/DOB, so a rewrite that leaves PHI does not reach the archive.
// Pixel OCR is not claimed. Curated public imports do not use this module.

import AdmZip from "adm-zip";
import { upsertDeidReport } from "./cases";
import { DeidFailError, type DeidReport } from "./deid";
import { scheduleSeriesBundle } from "./dicomCdn/jobs";
import { looksLikeDicomUid, readDicomUids } from "./healthcareDicom";
import { imagingStudySummary, orthancIngestInstance, orthancSeriesMeta } from "./orthanc";
import { TeachingDeidError, deidentifyTeachingInstance } from "./teachingDeidentify";

/** Cover-ready metadata for one uploaded series (mirrors UploadedSeries). */
export interface UploadSeriesOut {
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

export interface UploadSkipped {
  name: string;
  reason: string;
}

export interface UploadIngestOk {
  stored: number;
  /** Instances already stored (same remapped SOP) and not counted again. */
  duplicates: number;
  /** Instances whose identity tags were blanked before STOW. */
  deidentified: number;
  series: UploadSeriesOut[];
  failed: UploadSkipped[];
  skipped: UploadSkipped[];
}

export type UploadIngestResult =
  | { status: 400; body: { error: string } }
  | { status: 200; body: UploadIngestOk };

interface Candidate {
  name: string;
  bytes: ArrayBuffer;
}

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
  return (
    magic[0] === 0x44 && magic[1] === 0x49 && magic[2] === 0x43 && magic[3] === 0x4d
  );
}

function classify(name: string, bytes: ArrayBuffer): { skip?: string } {
  const base = baseName(name).toLowerCase();
  if (JUNK_NAMES.has(base)) return { skip: "system file" };
  if (base.startsWith(".")) return { skip: "hidden file" };
  if (NON_DICOM_EXT.test(base)) return { skip: "not a DICOM file" };
  if (!looksLikeDicom(bytes)) return { skip: "not a DICOM file" };
  return {};
}

/** Turn an archive error into something a radiologist can act on. */
function friendlyStoreError(e: unknown): string {
  if (e instanceof TeachingDeidError) return e.userMessage;
  if (e instanceof DeidFailError || (e instanceof Error && e.message.startsWith("DEID_FAIL"))) {
    return "patient identifiers were still present after automatic de-identification";
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/-> 401\b|-> 403\b/.test(msg)) return "imaging archive rejected the server credential";
  if (/-> 4\d\d/.test(msg)) return "not a valid DICOM file";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|timeout/i.test(msg)) {
    return "imaging archive unreachable";
  }
  return "couldn't be stored";
}

/**
 * Expand zips, skip junk, and STOW each DICOM instance that passes the de-id gate.
 */
export async function ingestUpload(orgId: string, form: FormData): Promise<UploadIngestResult> {
  const uploaded = form.getAll("files").filter((f): f is File => f instanceof File);
  if (uploaded.length === 0) {
    return { status: 400, body: { error: "No files were uploaded." } };
  }

  const skipped: UploadSkipped[] = [];
  const candidates: Candidate[] = [];

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
          else candidates.push({ name: `${name} › ${entryName}`, bytes: buf });
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

  const seriesMap = new Map<string, { studyId: string; count: number }>();
  const deidByStudy = new Map<string, DeidReport>();
  const seenSop = new Set<string>();
  let stored = 0;
  let duplicates = 0;
  let deidentified = 0;
  const failed: UploadSkipped[] = [];

  for (const c of candidates) {
    let bytes = c.bytes;
    try {
      const cleaned = deidentifyTeachingInstance(new Uint8Array(c.bytes));
      if (cleaned.removed.length > 0) deidentified++;
      bytes = toArrayBuffer(cleaned.bytes);
    } catch (e) {
      failed.push({ name: c.name, reason: friendlyStoreError(e) });
      continue;
    }

    const uids = readDicomUids(bytes);
    if (uids && seenSop.has(uids.sop)) {
      duplicates++;
      continue;
    }

    try {
      const res = await orthancIngestInstance(bytes);
      if (uids) seenSop.add(uids.sop);
      if (!deidByStudy.has(res.ParentStudy)) {
        deidByStudy.set(res.ParentStudy, res.deidReport);
      }
      if (res.Status === "AlreadyStored") {
        duplicates++;
        if (!seriesMap.has(res.ParentSeries)) {
          seriesMap.set(res.ParentSeries, { studyId: res.ParentStudy, count: 0 });
        }
        continue;
      }
      stored++;
      const existing = seriesMap.get(res.ParentSeries);
      if (existing) existing.count++;
      else seriesMap.set(res.ParentSeries, { studyId: res.ParentStudy, count: 1 });
    } catch (e) {
      failed.push({ name: c.name, reason: friendlyStoreError(e) });
    }
  }

  const series: UploadSeriesOut[] = [];
  const studyCache = new Map<
    string,
    { studyInstanceUID: string; studyDescription: string; studyDate?: string }
  >();
  for (const [seriesId, info] of seriesMap) {
    try {
      let study = studyCache.get(info.studyId);
      if (!study) {
        study = await imagingStudySummary(info.studyId);
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
        // Trust our own per-batch tally over the archive's count (which would be
        // global across multiple batches of the same series).
        instances: info.count,
      });
    } catch (e) {
      // Healthcare ids are the DICOM UIDs we already parsed at STOW time.
      // If QIDO lags the store, still return the series so the case can be created.
      if (looksLikeDicomUid(seriesId) && looksLikeDicomUid(info.studyId)) {
        const report = deidByStudy.get(info.studyId);
        if (report) {
          await upsertDeidReport(orgId, {
            ...report,
            studyInstanceUID: report.studyInstanceUID || info.studyId,
            studyId: info.studyId,
          }).catch(() => undefined);
        }
        series.push({
          studyInstanceUID: info.studyId,
          seriesInstanceUID: seriesId,
          studyDescription: "Study",
          orthancStudyId: info.studyId,
          instances: info.count,
        });
      } else {
        failed.push({
          name: `series ${seriesId.slice(0, 8)}`,
          reason: friendlyStoreError(e),
        });
      }
    }
  }

  // Convert each touched series to HTJ2K + previews once the upload settles
  // (lib/dicomCdn/jobs.ts). Reads the de-identified bytes back from the
  // archive, so it never sees anything the gate above did not pass. No-op
  // unless DICOM_CDN_BUCKET / DICOM_CDN_LOCAL_DIR is set.
  if (stored > 0) {
    for (const s of series) scheduleSeriesBundle(s.studyInstanceUID, s.seriesInstanceUID);
  }

  return { status: 200, body: { stored, duplicates, deidentified, series, failed, skipped } };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
