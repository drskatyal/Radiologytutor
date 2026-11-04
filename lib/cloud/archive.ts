// IMAGING SEAM: the DICOMweb archive that holds stored (anonymised) studies.
//
// Production: Cloud Healthcare API DICOM store (DICOMWEB_BACKEND=healthcare),
// bearer token from the Cloud Run metadata server (lib/gcpAuth.ts).
// Development: Orthanc (ORTHANC_URL) with basic auth.
// Selection and roots live in lib/imagingBackend.ts (unchanged from RadLearn).
//
// Writes (STOW-RS) and deletes go only through here, after the route has
// checked ownership, quota and the identity gate. The read proxy
// (/api/dicomweb) reuses `archiveAuthHeader`.

import { gcpAccessToken } from "@/lib/gcpAuth";
import { dicomWebRoot, imagingBackend, imagingConfigured, orthancBaseUrl, orthancBasicAuth } from "@/lib/imagingBackend";

export function archiveConfigured(): boolean {
  return imagingConfigured();
}

export async function archiveAuthHeader(): Promise<string> {
  return imagingBackend() === "healthcare" ? `Bearer ${await gcpAccessToken()}` : orthancBasicAuth();
}

export { dicomWebRoot };

/** STOW-RS one Part-10 instance into the archive. */
export async function stowInstance(bytes: Uint8Array): Promise<void> {
  const boundary = `flowrad-${crypto.randomUUID()}`;
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const res = await fetch(`${dicomWebRoot()}/studies`, {
    method: "POST",
    headers: {
      Authorization: await archiveAuthHeader(),
      "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}`,
      Accept: "application/dicom+json",
    },
    body,
    cache: "no-store",
  });
  // 409 = the instance already exists (a retried upload): fine.
  if (!res.ok && res.status !== 409) throw new Error(`STOW -> ${res.status}`);
}

/** Remove a whole study from the archive. */
export async function deleteArchivedStudy(studyInstanceUID: string): Promise<void> {
  if (imagingBackend() === "healthcare") {
    const res = await fetch(`${dicomWebRoot()}/studies/${encodeURIComponent(studyInstanceUID)}`, {
      method: "DELETE",
      headers: { Authorization: await archiveAuthHeader() },
      cache: "no-store",
    });
    if (!res.ok && res.status !== 404) throw new Error(`Healthcare delete -> ${res.status}`);
    return;
  }
  // Orthanc: find the internal id, then DELETE through its REST API.
  const base = orthancBaseUrl();
  const auth = orthancBasicAuth();
  const find = await fetch(`${base}/tools/lookup`, { method: "POST", headers: { Authorization: auth }, body: studyInstanceUID, cache: "no-store" });
  if (!find.ok) throw new Error(`Orthanc lookup -> ${find.status}`);
  const hits = (await find.json()) as { ID: string; Type: string }[];
  for (const hit of hits.filter((h) => h.Type === "Study")) {
    const res = await fetch(`${base}/studies/${hit.ID}`, { method: "DELETE", headers: { Authorization: auth }, cache: "no-store" });
    if (!res.ok && res.status !== 404) throw new Error(`Orthanc delete -> ${res.status}`);
  }
}

/** WADO-RS: list instance UIDs of one study, grouped by series. */
export async function listStudyInstances(studyInstanceUID: string): Promise<{ series: string; sop: string }[]> {
  const res = await fetch(`${dicomWebRoot()}/studies/${encodeURIComponent(studyInstanceUID)}/instances?includefield=0020000E`, {
    headers: { Authorization: await archiveAuthHeader(), Accept: "application/dicom+json" },
    cache: "no-store",
  });
  if (res.status === 204 || res.status === 404) return [];
  if (!res.ok) throw new Error(`QIDO instances -> ${res.status}`);
  const rows = (await res.json()) as Record<string, { Value?: unknown[] }>[];
  return rows
    .map((r) => ({ series: String(r["0020000E"]?.Value?.[0] ?? ""), sop: String(r["00080018"]?.Value?.[0] ?? "") }))
    .filter((r) => r.series && r.sop);
}

/** WADO-RS: one instance as Part-10 bytes (stored transfer syntax). */
export async function retrieveInstance(study: string, series: string, sop: string): Promise<Uint8Array> {
  const url = `${dicomWebRoot()}/studies/${encodeURIComponent(study)}/series/${encodeURIComponent(series)}/instances/${encodeURIComponent(sop)}`;
  const res = await fetch(url, {
    headers: { Authorization: await archiveAuthHeader(), Accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`WADO instance -> ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  return firstMultipartPart(body, res.headers.get("content-type") ?? "");
}

/** The first part of a multipart/related body (or the body if not multipart). */
export function firstMultipartPart(body: Uint8Array, contentType: string): Uint8Array {
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!/multipart/i.test(contentType) || !m) return body;
  const latin = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1");
  const delim = `--${m[1]}`;
  const start = latin.indexOf(delim);
  if (start < 0) return body;
  const headerEnd = latin.indexOf("\r\n\r\n", start);
  if (headerEnd < 0) return body;
  const next = latin.indexOf(`\r\n${delim}`, headerEnd + 4);
  return body.subarray(headerEnd + 4, next < 0 ? body.length : next);
}
