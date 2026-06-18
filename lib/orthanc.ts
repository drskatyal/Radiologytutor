// Server-only helpers for talking to our Orthanc DICOMweb backend.
// Orthanc lives on Railway behind Basic auth; the browser never talks to it
// directly — our API routes (DICOMweb proxy + upload) do, so there's no CORS
// and the credentials never reach the client.

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
