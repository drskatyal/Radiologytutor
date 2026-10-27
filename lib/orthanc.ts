// Server-only helpers for the imaging archive.
//
// The browser never talks to the archive. /api/dicomweb proxies WADO-RS and
// upload/ingest goes through orthancIngestInstance (de-id gate, then store).
//
// Two backends, one caller-facing API (see lib/imagingBackend.ts):
//   orthanc      — local docker / Fly 6PN. REST ids are Orthanc's own.
//   healthcare   — Cloud Healthcare API DICOM store. Ids ARE DICOM UIDs.
//                  QIDO/STOW live in lib/healthcareDicom.ts.

import {
  assertDeidPass,
  inspectDicomBytes,
  type DeidInspectOptions,
  type DeidReport,
} from "./deid";
import { gcpAccessToken } from "./gcpAuth";
import {
  dicomWebRoot,
  imagingBackend,
  imagingConfigured,
  orthancBaseUrl,
  orthancBasicAuth,
  upstreamAccept,
  type InstanceRef,
  type SeriesMeta,
} from "./imagingBackend";
import {
  healthcareFindSeries,
  healthcareFindStudy,
  healthcareSeriesInstances,
  healthcareSeriesMeta,
  healthcareStoreInstance,
  healthcareStudySeriesMeta,
  healthcareStudySummary,
} from "./healthcareDicom";

export { dicomWebRoot, imagingBackend, upstreamAccept };
export type { InstanceRef, SeriesMeta };

export function orthancConfigured(): boolean {
  return imagingConfigured();
}

export function orthancBase(): string {
  return orthancBaseUrl();
}

export function orthancAuthHeader(): string {
  return orthancBasicAuth();
}

/** Bearer token on Healthcare, Basic on Orthanc. */
export async function imagingAuthHeader(): Promise<string> {
  if (imagingBackend() === "healthcare") {
    return "Bearer " + (await gcpAccessToken());
  }
  return orthancAuthHeader();
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
  if (imagingBackend() === "healthcare") return healthcareStoreInstance(bytes);
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

/** Resolve a study's DICOM StudyInstanceUID + description from its archive id. */
export async function orthancStudyUIDs(
  orthancStudyId: string
): Promise<{ studyInstanceUID: string; description: string }> {
  const summary = await imagingStudySummary(orthancStudyId);
  return { studyInstanceUID: summary.studyInstanceUID, description: summary.studyDescription };
}

/**
 * UID, description, and date for an archive study id.
 * On Healthcare the id is the StudyInstanceUID. On Orthanc it is Orthanc's id.
 */
export async function imagingStudySummary(studyId: string): Promise<{
  studyInstanceUID: string;
  studyDescription: string;
  studyDate?: string;
}> {
  if (imagingBackend() === "healthcare") return healthcareStudySummary(studyId);
  const study = await orthancGet<{
    MainDicomTags: {
      StudyInstanceUID: string;
      StudyDescription?: string;
      StudyDate?: string;
    };
    PatientMainDicomTags?: { PatientName?: string };
  }>(`/studies/${studyId}`);
  const tags = study.MainDicomTags;
  return {
    studyInstanceUID: tags.StudyInstanceUID,
    studyDescription: tags.StudyDescription || study.PatientMainDicomTags?.PatientName || "Study",
    studyDate: tags.StudyDate || undefined,
  };
}

/**
 * Id to pass to orthancStudySeriesMeta.
 * Healthcare ignores a stored Orthanc hash and resolves the DICOM UID, so a
 * study row written on Fly still opens after the archive moves.
 */
export async function imagingStudyKey(
  storedOrthancId: string | undefined,
  studyInstanceUID: string
): Promise<string | null> {
  if (imagingBackend() === "healthcare") return healthcareFindStudy(studyInstanceUID);
  if (storedOrthancId) return storedOrthancId;
  return orthancFindStudyByUID(studyInstanceUID);
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
 *
 * `opts` relaxes the gate ONLY for the curated public-collection importer
 * (TCIA research pseudonyms). Operator uploads must never pass it — the default
 * is the strict gate.
 */
export async function orthancIngestInstance(
  bytes: ArrayBuffer,
  opts: DeidInspectOptions = {}
): Promise<OrthancIngestResult> {
  const deidReport = inspectDicomBytes(bytes, opts);
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

/** List a study's series (by archive study id) with compact, cover-ready metadata. */
export async function orthancStudySeriesMeta(orthancStudyId: string): Promise<SeriesMeta[]> {
  if (imagingBackend() === "healthcare") return healthcareStudySeriesMeta(orthancStudyId);
  const study = await orthancGet<{ Series: string[] }>(`/studies/${orthancStudyId}`);
  const metas = await Promise.all(
    study.Series.map((sid) => orthancSeriesMeta(sid))
  );
  return metas.sort((a, b) => (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0));
}

/** Compact metadata for a single series (by archive series id). */
export async function orthancSeriesMeta(orthancSeriesId: string): Promise<SeriesMeta> {
  if (imagingBackend() === "healthcare") return healthcareSeriesMeta(orthancSeriesId);
  const series = await orthancGet<OrthancSeriesRecord>(`/series/${orthancSeriesId}`);
  const tags = series.MainDicomTags;
  // Instances.length is the archive's count for this series. Do not also
  // GET the first instance here — that round trip existed only to feed a
  // thumbnail, and the rail fetches a cover after the viewport has painted.
  const instanceCount = series.Instances.length;
  return {
    seriesInstanceUID: tags.SeriesInstanceUID,
    orthancSeriesId,
    modality: tags.Modality,
    seriesDescription: tags.SeriesDescription,
    seriesNumber: tags.SeriesNumber ? Number(tags.SeriesNumber) : undefined,
    ...(instanceCount > 0 ? { instanceCount } : {}),
  };
}

/**
 * Ordered SOP Instance UIDs of a series (by Orthanc series id), sorted by
 * InstanceNumber. Used to enumerate exactly which slices a case will need.
 */
export async function orthancSeriesInstances(orthancSeriesId: string): Promise<InstanceRef[]> {
  if (imagingBackend() === "healthcare") return healthcareSeriesInstances(orthancSeriesId);
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
    if (imagingBackend() === "healthcare") return await healthcareFindStudy(studyInstanceUID);
    const matches = await orthancFind<string[]>("Study", { StudyInstanceUID: studyInstanceUID });
    return matches[0] ?? null;
  } catch {
    return null;
  }
}

/** Resolve an Orthanc series id from a DICOM SeriesInstanceUID (via REST lookup). */
export async function orthancFindSeriesByUID(seriesInstanceUID: string): Promise<string | null> {
  try {
    if (imagingBackend() === "healthcare") return await healthcareFindSeries(seriesInstanceUID);
    const matches = await orthancFind<string[]>("Series", {
      SeriesInstanceUID: seriesInstanceUID,
    });
    return matches[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * WADO-RS retrieve of one Part-10 instance. Works on Orthanc and Healthcare
 * (Accept application/dicom, no transcode). Used to re-read bytes for de-id
 * when the instance is already in the archive.
 */
/**
 * One instance from a series, for the de-id re-check on import.
 * Orthanc uses its REST file endpoint (one series GET + one file GET).
 * Healthcare uses QIDO limit=1 plus a WADO-RS retrieve — not a full instance list.
 */
export async function fetchSeriesSampleDicom(
  studyInstanceUID: string,
  seriesInstanceUID: string
): Promise<ArrayBuffer | null> {
  if (imagingBackend() === "healthcare") {
    const meta = await healthcareSeriesMeta(seriesInstanceUID);
    if (!meta.firstInstanceUID) return null;
    return fetchInstanceDicom(studyInstanceUID, seriesInstanceUID, meta.firstInstanceUID);
  }
  const seriesId = await orthancFindSeriesByUID(seriesInstanceUID);
  if (!seriesId) return null;
  const series = await orthancGet<{ Instances: string[] }>(`/series/${seriesId}`);
  const instId = series.Instances[0];
  if (!instId) return null;
  const fileRes = await fetch(`${orthancBase()}/instances/${instId}/file`, {
    headers: { Authorization: orthancAuthHeader() },
    cache: "no-store",
  });
  if (!fileRes.ok) return null;
  return fileRes.arrayBuffer();
}

export async function fetchInstanceDicom(
  studyInstanceUID: string,
  seriesInstanceUID: string,
  sopInstanceUID: string
): Promise<ArrayBuffer | null> {
  const url =
    `${dicomWebRoot()}/studies/${encodeURIComponent(studyInstanceUID)}` +
    `/series/${encodeURIComponent(seriesInstanceUID)}` +
    `/instances/${encodeURIComponent(sopInstanceUID)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: await imagingAuthHeader(),
      Accept: "application/dicom; transfer-syntax=*",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.arrayBuffer();
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
