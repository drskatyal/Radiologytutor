// Cloud Healthcare API DICOM store — DICOMweb only.
//
// Orthanc's REST (/studies/{orthancId}, /tools/find, /instances) does not
// exist here. Callers in lib/orthanc.ts translate those helpers onto QIDO-RS
// and STOW-RS. Resource ids on this backend ARE DICOM UIDs.
//
// Pixel reads for the viewer do not go through this file. They are proxied
// by /api/dicomweb straight at dicomWebRoot(), with a service-account bearer.

import { randomUUID } from "node:crypto";
import { parseDicom } from "dicom-parser";
import { gcpAccessToken } from "./gcpAuth";
import {
  dicomWebRoot,
  imagingBackend,
  type InstanceRef,
  type SeriesMeta,
} from "./imagingBackend";

export interface DicomJsonElement {
  vr?: string;
  Value?: unknown[];
}
export type DicomJson = Record<string, DicomJsonElement>;

export function dicomJsonString(ds: DicomJson | undefined, tag: string): string | undefined {
  const raw = ds?.[tag]?.Value?.[0];
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (raw && typeof raw === "object" && "Alphabetic" in raw) {
    const alphabetic = (raw as { Alphabetic?: unknown }).Alphabetic;
    if (typeof alphabetic === "string" && alphabetic.trim()) return alphabetic.trim();
  }
  return undefined;
}

function dicomJsonNumber(ds: DicomJson | undefined, tag: string): number | undefined {
  const s = dicomJsonString(ds, tag);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** DICOM UIDs are dotted numeric; Orthanc internal ids are not. */
export function looksLikeDicomUid(value: string): boolean {
  return /^\d+(\.\d+)+$/.test(value);
}

export interface DicomUids {
  study: string;
  series: string;
  sop: string;
}

/** Pull Study/Series/SOP UIDs out of a Part-10 file. Null when unreadable. */
export function readDicomUids(bytes: ArrayBuffer): DicomUids | null {
  try {
    const dataSet = parseDicom(new Uint8Array(bytes));
    const study = dataSet.string("x0020000d");
    const series = dataSet.string("x0020000e");
    const sop = dataSet.string("x00080018");
    if (!study || !series || !sop) return null;
    if (!looksLikeDicomUid(study) || !looksLikeDicomUid(series) || !looksLikeDicomUid(sop)) {
      return null;
    }
    return { study, series, sop };
  } catch {
    return null;
  }
}

async function bearer(): Promise<string> {
  return "Bearer " + (await gcpAccessToken());
}

export async function healthcareQido(pathAndQuery: string): Promise<DicomJson[]> {
  if (imagingBackend() !== "healthcare") {
    throw new Error("Healthcare QIDO called while DICOMWEB_BACKEND is orthanc.");
  }
  const res = await fetch(`${dicomWebRoot()}/${pathAndQuery}`, {
    headers: {
      Authorization: await bearer(),
      Accept: "application/dicom+json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return [];
  if (!res.ok) {
    const path = pathAndQuery.split("?")[0];
    throw new Error(`Healthcare QIDO ${path} -> ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as DicomJson[]) : [];
}

function seriesMetaFrom(row: DicomJson, seriesUid: string, firstInstanceUID?: string): SeriesMeta {
  const tagged = dicomJsonNumber(row, "00201209");
  const instanceCount = tagged != null && tagged > 0 ? Math.round(tagged) : undefined;
  return {
    seriesInstanceUID: dicomJsonString(row, "0020000E") || seriesUid,
    orthancSeriesId: seriesUid,
    modality: dicomJsonString(row, "00080060"),
    seriesDescription: dicomJsonString(row, "0008103E"),
    seriesNumber: dicomJsonNumber(row, "00200011"),
    // Healthcare QIDO often omits NumberOfSeriesRelatedInstances (0020,1209).
    // A missing tag is unknown, not an empty series. The rail counts the
    // instance list after the main image is up (lib/seriesRail.ts).
    ...(instanceCount != null ? { instanceCount } : {}),
    ...(firstInstanceUID ? { firstInstanceUID } : {}),
  };
}

export async function healthcareFindStudy(studyInstanceUID: string): Promise<string | null> {
  const rows = await healthcareQido(
    `studies?${new URLSearchParams({ StudyInstanceUID: studyInstanceUID, limit: "1" })}`
  );
  return rows.length > 0 ? studyInstanceUID : null;
}

export async function healthcareFindSeries(seriesInstanceUID: string): Promise<string | null> {
  const rows = await healthcareQido(
    `series?${new URLSearchParams({ SeriesInstanceUID: seriesInstanceUID, limit: "1" })}`
  );
  return rows.length > 0 ? seriesInstanceUID : null;
}

export async function healthcareStudySummary(studyUid: string): Promise<{
  studyInstanceUID: string;
  studyDescription: string;
  studyDate?: string;
}> {
  const rows = await healthcareQido(
    `studies?${new URLSearchParams({
      StudyInstanceUID: studyUid,
      includefield: "00081030,00080020",
      limit: "1",
    })}`
  );
  const row = rows[0];
  if (!row) throw new Error(`Healthcare QIDO studies -> 404`);
  return {
    studyInstanceUID: dicomJsonString(row, "0020000D") || studyUid,
    studyDescription:
      dicomJsonString(row, "00081030") || dicomJsonString(row, "00100010") || "Study",
    studyDate: dicomJsonString(row, "00080020"),
  };
}

export async function healthcareStudySeriesMeta(studyUid: string): Promise<SeriesMeta[]> {
  if (!looksLikeDicomUid(studyUid)) {
    throw new Error("Healthcare study id must be a StudyInstanceUID.");
  }
  const rows = await healthcareQido(
    `studies/${encodeURIComponent(studyUid)}/series?${new URLSearchParams({
      includefield: "00200011,00201209",
      limit: "500",
    })}`
  );
  // Series-level QIDO only. A per-series instance query (thumbnail SOP,
  // NumberOfSeriesRelatedInstances) used to run here and held the viewer
  // until every series answered. Covers load lazily in the rail, after the
  // first frame. Instance counts that the tag omits stay unknown.
  const metas = rows.map((row): SeriesMeta | null => {
    const seriesUid = dicomJsonString(row, "0020000E");
    if (!seriesUid) return null;
    return seriesMetaFrom(row, seriesUid);
  });
  return metas
    .filter((m): m is SeriesMeta => m != null)
    .sort((a, b) => (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0));
}

export async function healthcareSeriesMeta(seriesUid: string): Promise<SeriesMeta> {
  const rows = await healthcareQido(
    `series?${new URLSearchParams({
      SeriesInstanceUID: seriesUid,
      includefield: "00200011,00201209",
      limit: "1",
    })}`
  );
  const row = rows[0];
  if (!row) throw new Error(`Healthcare QIDO series -> 404`);
  let firstInstanceUID: string | undefined;
  try {
    const first = await healthcareQido(
      `instances?${new URLSearchParams({ SeriesInstanceUID: seriesUid, limit: "1" })}`
    );
    firstInstanceUID = dicomJsonString(first[0], "00080018");
  } catch {
    firstInstanceUID = undefined;
  }
  return seriesMetaFrom(row, seriesUid, firstInstanceUID);
}

/** Every instance in a series, ordered by InstanceNumber. Pages past QIDO's default cap. */
export async function healthcareSeriesInstances(seriesUid: string): Promise<InstanceRef[]> {
  const out: InstanceRef[] = [];
  const page = 2000;
  for (let offset = 0; offset < 50_000; offset += page) {
    const rows = await healthcareQido(
      `instances?${new URLSearchParams({
        SeriesInstanceUID: seriesUid,
        limit: String(page),
        offset: String(offset),
      })}`
    );
    for (const row of rows) {
      const sop = dicomJsonString(row, "00080018");
      if (!sop) continue;
      out.push({
        sopInstanceUID: sop,
        instanceNumber: dicomJsonNumber(row, "00200013"),
      });
    }
    if (rows.length < page) break;
  }
  return out.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
}

export interface HealthcareStoreResult {
  ID: string;
  ParentStudy: string;
  ParentSeries: string;
  Status: string;
}

/**
 * STOW-RS a single Part-10 instance. UIDs come from the file itself so we
 * don't depend on the store echoing them. The de-id gate has already run.
 */
export async function healthcareStoreInstance(bytes: ArrayBuffer): Promise<HealthcareStoreResult> {
  const uids = readDicomUids(bytes);
  if (!uids) throw new Error("Healthcare STOW -> 400");
  const boundary = `radlearn-${randomUUID()}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await fetch(`${dicomWebRoot()}/studies`, {
    method: "POST",
    headers: {
      Authorization: await bearer(),
      "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}`,
      Accept: "application/dicom+json",
    },
    body: payload,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok && res.status !== 409) throw new Error(`Healthcare STOW -> ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  const dataset = (Array.isArray(body) ? body[0] : body) as DicomJson | null;
  const failures = dataset?.["00081198"]?.Value;
  const acknowledged = dataset?.["00081199"]?.Value?.some(item =>
    dicomJsonString(item as DicomJson, "00081155") === uids.sop);
  if (failures?.length || !acknowledged) throw new Error(`Healthcare STOW -> ${res.status}: instance was not acknowledged`);
  return {
    ID: uids.sop,
    ParentStudy: uids.study,
    ParentSeries: uids.series,
    Status: res.status === 409 ? "AlreadyStored" : "Success",
  };
}
