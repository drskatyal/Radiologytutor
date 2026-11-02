// Which DICOMweb archive the server talks to.
//
//   orthanc      — local/dev and the existing Fly private Orthanc (ORTHANC_URL).
//   healthcare   — Cloud Healthcare API DICOM store (production on Cloud Run).
//
// Selection:
//   DICOMWEB_BACKEND=orthanc|healthcare wins when set.
//   Otherwise a configured Healthcare store is used only when ORTHANC_URL is
//   unset, so a laptop that still points at localhost Orthanc never flips
//   over because a Healthcare project id happens to be in the environment.

export type ImagingBackend = "orthanc" | "healthcare";

/** Compact metadata for one series (covers + prefetch ordering). */
export interface SeriesMeta {
  seriesInstanceUID: string;
  /** Archive id. Orthanc's id, or the SeriesInstanceUID on Healthcare. */
  orthancSeriesId: string;
  modality?: string;
  seriesDescription?: string;
  seriesNumber?: number;
  /**
   * Positive instance count from the archive. Omit when the QIDO tag is
   * missing or zero — that tag is not a reliable empty-series signal.
   */
  instanceCount?: number;
  /** SOP Instance UID of the first slice — enough for a cover thumbnail. */
  firstInstanceUID?: string;
}

/** One instance reference, ordered by InstanceNumber (for prefetch ordering). */
export interface InstanceRef {
  sopInstanceUID: string;
  instanceNumber?: number;
}

export interface ImagingEnv {
  dicomwebBackend?: string;
  orthancUrl?: string;
  orthancUser?: string;
  orthancPassword?: string;
  healthcareProject?: string;
  healthcareLocation?: string;
  healthcareDataset?: string;
  healthcareDicomStore?: string;
  /** Full dicomWeb root, no trailing slash. Overrides the four ids above. */
  healthcareDicomwebUrl?: string;
}

export function readImagingEnv(env: NodeJS.ProcessEnv = process.env): ImagingEnv {
  return {
    dicomwebBackend: env.DICOMWEB_BACKEND,
    orthancUrl: env.ORTHANC_URL,
    orthancUser: env.ORTHANC_USER,
    orthancPassword: env.ORTHANC_PASSWORD,
    healthcareProject: env.HEALTHCARE_PROJECT,
    healthcareLocation: env.HEALTHCARE_LOCATION,
    healthcareDataset: env.HEALTHCARE_DATASET,
    healthcareDicomStore: env.HEALTHCARE_DICOM_STORE,
    healthcareDicomwebUrl: env.HEALTHCARE_DICOMWEB_URL,
  };
}

export function healthcareReady(env: ImagingEnv): boolean {
  if (env.healthcareDicomwebUrl?.trim()) return true;
  return Boolean(
    env.healthcareProject?.trim() &&
      env.healthcareLocation?.trim() &&
      env.healthcareDataset?.trim() &&
      env.healthcareDicomStore?.trim()
  );
}

export function resolveImagingBackend(env: ImagingEnv): ImagingBackend {
  const explicit = env.dicomwebBackend?.trim().toLowerCase();
  if (explicit === "healthcare" || explicit === "orthanc") return explicit;
  if (healthcareReady(env) && !env.orthancUrl?.trim()) return "healthcare";
  return "orthanc";
}

export function imagingBackend(): ImagingBackend {
  return resolveImagingBackend(readImagingEnv());
}

/** True when the active archive can accept reads and STOW/ingest. */
export function imagingConfigured(env: ImagingEnv = readImagingEnv()): boolean {
  if (resolveImagingBackend(env) === "healthcare") return healthcareReady(env);
  return Boolean(env.orthancUrl?.trim());
}

/**
 * WADO-RS / QIDO-RS / STOW-RS root with no trailing slash.
 * Orthanc: `{ORTHANC_URL}/dicom-web`
 * Healthcare: `https://healthcare.googleapis.com/v1/projects/.../dicomWeb`
 */
export function dicomWebRoot(env: ImagingEnv = readImagingEnv()): string {
  if (resolveImagingBackend(env) === "healthcare") {
    const explicit = env.healthcareDicomwebUrl?.trim().replace(/\/+$/, "");
    if (explicit) return explicit;
    const project = env.healthcareProject?.trim();
    const location = env.healthcareLocation?.trim();
    const dataset = env.healthcareDataset?.trim();
    const store = env.healthcareDicomStore?.trim();
    if (!project || !location || !dataset || !store) {
      throw new Error(
        "Healthcare DICOM store is not configured (HEALTHCARE_PROJECT, HEALTHCARE_LOCATION, HEALTHCARE_DATASET, HEALTHCARE_DICOM_STORE)."
      );
    }
    return (
      "https://healthcare.googleapis.com/v1" +
      `/projects/${encodeURIComponent(project)}` +
      `/locations/${encodeURIComponent(location)}` +
      `/datasets/${encodeURIComponent(dataset)}` +
      `/dicomStores/${encodeURIComponent(store)}` +
      "/dicomWeb"
    );
  }
  const base = env.orthancUrl?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("ORTHANC_URL is not configured.");
  return `${base}/dicom-web`;
}

export function orthancBaseUrl(env: ImagingEnv = readImagingEnv()): string {
  return (env.orthancUrl ?? "").replace(/\/+$/, "");
}

export function orthancBasicAuth(env: ImagingEnv = readImagingEnv()): string {
  const user = env.orthancUser?.trim() || "flowrad";
  const password = env.orthancPassword ?? "";
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

/**
 * Accept header to send upstream for a DICOMweb path.
 *
 * Frames: Cornerstone asks for `transfer-syntax=*` so the archive returns the
 * stored encoding and skips a transcode. A bare `application/octet-stream`
 * is rewritten to that multipart form — Healthcare rejects the bare type
 * with 406. The student warmer sends the Cornerstone Accept itself.
 *
 * Rendered thumbnails: `<img>` sends `image/webp,image/*`. Healthcare rendered
 * resources answer `image/jpeg` (single part), which the browser can paint.
 * Forcing that Accept keeps series covers working on both archives.
 */
export const WADO_FRAME_ACCEPT =
  "multipart/related; type=application/octet-stream; transfer-syntax=*";

export function upstreamAccept(path: string, accept: string | null): string | null {
  if (/\/rendered$/i.test(path)) return "image/jpeg";
  if (!/\/frames\/\d+/i.test(path)) return accept;
  const trimmed = accept?.trim() ?? "";
  if (!trimmed || trimmed === "*/*" || /^application\/octet-stream$/i.test(trimmed)) {
    return WADO_FRAME_ACCEPT;
  }
  if (!/transfer-syntax/i.test(trimmed)) return WADO_FRAME_ACCEPT;
  return accept;
}
