// Server-only TCIA (NBIA) series download. Public collections only — no auth token.
// Radiopaedia does not expose a download API; we pair authored teaching text with
// de-identified TCIA imaging (see lib/publicCases/catalog.ts).

const NBIA_BASE = "https://services.cancerimagingarchive.net/nbia-api/services/v1";

export interface TciaSeriesMeta {
  seriesInstanceUID: string;
  studyInstanceUID: string;
  modality?: string;
  seriesDescription?: string;
  bodyPartExamined?: string;
  collection?: string;
  imageCount?: number;
  studyDate?: string;
  licenseName?: string;
  licenseURI?: string;
}

/** Fetch compact metadata for one series (public API). */
export async function fetchTciaSeriesMeta(seriesInstanceUID: string): Promise<TciaSeriesMeta | null> {
  const url = `${NBIA_BASE}/getSeries?SeriesInstanceUID=${encodeURIComponent(seriesInstanceUID)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`TCIA getSeries -> ${res.status}`);
  const rows = (await res.json()) as Record<string, string>[];
  const row = rows[0];
  if (!row?.SeriesInstanceUID) return null;
  return {
    seriesInstanceUID: row.SeriesInstanceUID,
    studyInstanceUID: row.StudyInstanceUID,
    modality: row.Modality,
    seriesDescription: row.SeriesDescription,
    bodyPartExamined: row.BodyPartExamined,
    collection: row.Collection,
    imageCount: row.ImageCount ? Number(row.ImageCount) : undefined,
    studyDate: row.StudyDate,
    licenseName: row.LicenseName,
    licenseURI: row.LicenseURI,
  };
}

/** Download every DICOM instance in a series as raw Part-10 buffers (ZIP from NBIA). */
export async function downloadTciaSeriesDicom(seriesInstanceUID: string): Promise<ArrayBuffer[]> {
  const url = `${NBIA_BASE}/getImage?SeriesInstanceUID=${encodeURIComponent(seriesInstanceUID)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`TCIA getImage -> ${res.status}`);
  const zipBytes = await res.arrayBuffer();

  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip(Buffer.from(zipBytes));
  const buffers: ArrayBuffer[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.toLowerCase();
    if (!name.endsWith(".dcm")) continue;
    const buf = entry.getData();
    if (buf.byteLength < 132) continue;
    const magic = buf.subarray(128, 132);
    if (magic[0] !== 0x44 || magic[1] !== 0x49 || magic[2] !== 0x43 || magic[3] !== 0x4d) {
      continue;
    }
    buffers.push(new Uint8Array(buf).buffer);
  }

  if (buffers.length === 0) {
    throw new Error(`TCIA series ${seriesInstanceUID}: ZIP contained no DICOM instances`);
  }
  return buffers;
}
