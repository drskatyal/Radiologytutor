// Server-only helpers for talking to our Orthanc DICOMweb backend.
// Orthanc lives on Fly.io (private 6PN, see fly.orthanc.toml); the browser
// never talks to it directly — our API routes (DICOMweb proxy + upload) do,
// so there's no CORS and the credentials never reach the client.

import { assertDeidPass, inspectDicomBytes, type DeidReport } from "./deid";

const ORTHANC_URL = process.env.ORTHANC_URL ?? "";
const ORTHANC_USER = process.env.ORTHANC_USER ?? "flowrad";
const ORTHANC_PASSWORD = process.env.ORTHANC_PASSWORD ?? "";

export function orthancConfigured(): boolean {
  return Boolean(ORTHANC_URL);
}

export function orthancBase(): string {
  return ORTHANC_URL.replace(/\/+$/, "");
}

export function orthancAuthHeader(): string {
  return "Basic " + Buffer.from(`${ORTHANC_USER}:${ORTHANC_PASSWORD}`).toString("base64");
}

/** GET an Orthanc REST endpoint and parse JSON. */
export async function orthancGet<T>(path: string): Promise<T> {
  const res = await fetch(`${orthancBase()}${path}`, {
    headers: { Authorization: orthancAuthHeader() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Orthanc GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** POST raw DICOM bytes to Orthanc; returns its ingest result. */
export interface OrthancStoreResult {
  ID: string;
  ParentStudy: string;
  ParentSeries: string;
  Status: string;
}
export async function orthancStoreInstance(bytes: ArrayBuffer): Promise<OrthancStoreResult> {
  const res = await fetch(`${orthancBase()}/instances`, {
    method: "POST",
    headers: {
      Authorization: orthancAuthHeader(),
      "Content-Type": "application/dicom",
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Orthanc store -> ${res.status}`);
  return (await res.json()) as OrthancStoreResult;
}

/** Resolve a study's DICOM StudyInstanceUID + description from its Orthanc id. */
export async function orthancStudyUIDs(
  orthancStudyId: string
): Promise<{ studyInstanceUID: string; description: string }> {
  const study = await orthancGet<{
    MainDicomTags: { StudyInstanceUID: string; StudyDescription?: string };
    PatientMainDicomTags?: { PatientName?: string };
  }>(`/studies/${orthancStudyId}`);
  return {
    studyInstanceUID: study.MainDicomTags.StudyInstanceUID,
    description: study.MainDicomTags.StudyDescription || study.PatientMainDicomTags?.PatientName || "Study",
  };
}

/** Resolve a series' DICOM SeriesInstanceUID from its Orthanc id. */
export async function orthancSeriesUID(orthancSeriesId: string): Promise<string> {
  const series = await orthancGet<{ MainDicomTags: { SeriesInstanceUID: string } }>(
    `/series/${orthancSeriesId}`
  );
  return series.MainDicomTags.SeriesInstanceUID;
}

// ============================================================================
// Ingest seam — de-id quality gate (lib/deid.ts)
//
// All DICOM ingest funnels through `orthancIngestInstance`. We inspect headers
// and refuse instances with residual identity tags (PatientName/ID/DOB, …).
// We do NOT rewrite pixels here and we do NOT claim OCR ran. Callers never
// change when a byte-level scrubber slots in later — it belongs in this
// function, before orthancStoreInstance.
// ============================================================================

export interface OrthancIngestResult extends OrthancStoreResult {
  /** Passing header report from this instance — persist against the study UID. */
  deidReport: DeidReport;
}

/**
 * The single ingest entry point. Header identity gate, then store.
 * Throws DeidFailError when residual PHI remains.
 */
export async function orthancIngestInstance(bytes: ArrayBuffer): Promise<OrthancIngestResult> {
  const deidReport = inspectDicomBytes(bytes);
  assertDeidPass(deidReport);
  const stored = await orthancStoreInstance(bytes);
  return { ...stored, deidReport };
}

// ============================================================================
// Prefetch / case-cover helpers
//
// Cheap, server-side metadata reads used to (a) render the case-list cover and
// (b) compute the ordered instances a case will play, so the client can warm
// the /api/dicomweb cache. These hit Orthanc's REST API (compact JSON), not the
// heavier DICOMweb QIDO, so they stay light.
// ============================================================================

/** Compact metadata for one series (for covers + prefetch ordering). */
export interface SeriesMeta {
  seriesInstanceUID: string;
  orthancSeriesId: string;
  modality?: string;
  seriesDescription?: string;
  seriesNumber?: number;
  /** Number of instances (slices) in the series. */
  instanceCount: number;
  /** SOP Instance UID of the first slice — enough for a cover thumbnail. */
  firstInstanceUID?: string;
}

interface OrthancSeriesRecord {
  MainDicomTags: {
    SeriesInstanceUID: string;
    Modality?: string;
    SeriesDescription?: string;
    SeriesNumber?: string;
  };
  Instances: string[];
}

interface OrthancInstanceRecord {
  MainDicomTags: { SOPInstanceUID?: string; InstanceNumber?: string };
}

/** List a study's series (by Orthanc study id) with compact, cover-ready metadata. */
export async function orthancStudySeriesMeta(orthancStudyId: string): Promise<SeriesMeta[]> {
  const study = await orthancGet<{ Series: string[] }>(`/studies/${orthancStudyId}`);
  const metas = await Promise.all(
    study.Series.map((sid) => orthancSeriesMeta(sid))
  );
  return metas.sort((a, b) => (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0));
}

/** Compact metadata for a single series (by Orthanc series id). */
export async function orthancSeriesMeta(orthancSeriesId: string): Promise<SeriesMeta> {
  const series = await orthancGet<OrthancSeriesRecord>(`/series/${orthancSeriesId}`);
  const tags = series.MainDicomTags;
  const firstInstanceOrthancId = series.Instances[0];
  let firstInstanceUID: string | undefined;
  if (firstInstanceOrthancId) {
    try {
      const inst = await orthancGet<OrthancInstanceRecord>(`/instances/${firstInstanceOrthancId}`);
      firstInstanceUID = inst.MainDicomTags.SOPInstanceUID;
    } catch {
      // Cover is best-effort; missing first-instance UID just means no thumbnail.
    }
  }
  return {
    seriesInstanceUID: tags.SeriesInstanceUID,
    orthancSeriesId,
    modality: tags.Modality,
    seriesDescription: tags.SeriesDescription,
    seriesNumber: tags.SeriesNumber ? Number(tags.SeriesNumber) : undefined,
    instanceCount: series.Instances.length,
    firstInstanceUID,
  };
}

/** One instance reference, ordered by InstanceNumber (for prefetch ordering). */
export interface InstanceRef {
  sopInstanceUID: string;
  instanceNumber?: number;
}

/**
 * Ordered SOP Instance UIDs of a series (by Orthanc series id), sorted by
 * InstanceNumber. Used to enumerate exactly which slices a case will need.
 */
export async function orthancSeriesInstances(orthancSeriesId: string): Promise<InstanceRef[]> {
  const series = await orthancGet<OrthancSeriesRecord>(`/series/${orthancSeriesId}`);
  const refs = await Promise.all(
    series.Instances.map(async (iid): Promise<InstanceRef | null> => {
      try {
        const inst = await orthancGet<OrthancInstanceRecord>(`/instances/${iid}`);
        const uid = inst.MainDicomTags.SOPInstanceUID;
        if (!uid) return null;
        return {
          sopInstanceUID: uid,
          instanceNumber: inst.MainDicomTags.InstanceNumber
            ? Number(inst.MainDicomTags.InstanceNumber)
            : undefined,
        };
      } catch {
        return null;
      }
    })
  );
  return refs
    .filter((r): r is InstanceRef => r != null)
    .sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
}

/** Resolve an Orthanc study id from a DICOM StudyInstanceUID (via REST lookup). */
export async function orthancFindStudyByUID(studyInstanceUID: string): Promise<string | null> {
  try {
    const matches = await orthancFind<string[]>("Study", { StudyInstanceUID: studyInstanceUID });
    return matches[0] ?? null;
  } catch {
    return null;
  }
}

/** Resolve an Orthanc series id from a DICOM SeriesInstanceUID (via REST lookup). */
export async function orthancFindSeriesByUID(seriesInstanceUID: string): Promise<string | null> {
  try {
    const matches = await orthancFind<string[]>("Series", {
      SeriesInstanceUID: seriesInstanceUID,
    });
    return matches[0] ?? null;
  } catch {
    return null;
  }
}

/** POST to Orthanc's /tools/find with a query; returns matching resource ids. */
async function orthancFind<T>(level: "Study" | "Series", query: Record<string, string>): Promise<T> {
  const res = await fetch(`${orthancBase()}/tools/find`, {
    method: "POST",
    headers: {
      Authorization: orthancAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Level: level, Query: query }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Orthanc find ${level} -> ${res.status}`);
  return (await res.json()) as T;
}
