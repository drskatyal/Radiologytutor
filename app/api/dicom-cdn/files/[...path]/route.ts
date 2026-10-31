// GET /api/dicom-cdn/files/{study}/{series}/{version}/{file}
//
// Same-origin delivery of converted chunks when no Cloud CDN is configured
// (DICOM_CDN_URL unset) — dev, staging, or a CDN outage. Still one request per
// ~8–32 slices and HTJ2K, just without the edge cache. Authorised per request
// exactly like /api/dicomweb (lib/studyAccess.ts). Honours a single byte
// range (the slice on screen, fetched ahead of its chunk). Chunk paths are versioned
// and immutable, so the browser may keep them; `private` keeps them out of
// any shared cache.

import { NextRequest } from "next/server";
import { dicomCdnConfig } from "@/lib/dicomCdn/config";
import {
  CHUNK_CACHE_CONTROL,
  isBundleFile,
  isBundleVersion,
  isDicomUid,
  versionPrefix,
} from "@/lib/dicomCdn/format";
import { openBundleStore } from "@/lib/dicomCdn/store";
import { authorizeStudyRead } from "@/lib/studyAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: { path: string[] } }) {
  const config = dicomCdnConfig();
  if (!config) return new Response("Not found", { status: 404 });
  const [study, series, version, file, ...rest] = ctx.params.path;
  if (
    rest.length > 0 ||
    !study ||
    !series ||
    !version ||
    !file ||
    !isDicomUid(study) ||
    !isDicomUid(series) ||
    !isBundleVersion(version) ||
    !isBundleFile(file)
  ) {
    return new Response("Not found", { status: 404 });
  }
  const access = await authorizeStudyRead(req, study);
  if (!access.ok) {
    return new Response(access.status === 401 ? "Unauthorized" : "Not found", { status: access.status });
  }
  // A single `bytes=a-b` range: the viewer fetches the slice on screen out of
  // its chunk before the rest (offsets come from the bundle index).
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range")?.trim() ?? "");
  const key = `${versionPrefix(study, series, version)}/${file}`;
  let body: Uint8Array | null = null;
  try {
    const store = openBundleStore(config.store);
    body = range
      ? await store.getRange(key, Number(range[1]), Number(range[2]))
      : await store.get(key);
  } catch (e) {
    console.warn("[dicom-cdn] chunk read failed", { file, error: e instanceof Error ? e.message : String(e) });
    return new Response("Bundle store unavailable", { status: 502 });
  }
  if (!body) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": CHUNK_CACHE_CONTROL,
    "Content-Length": String(body.byteLength),
    "Accept-Ranges": "bytes",
  };
  if (range) {
    if (body.byteLength === 0) return new Response("Range Not Satisfiable", { status: 416 });
    headers["Content-Range"] = `bytes ${range[1]}-${Number(range[1]) + body.byteLength - 1}/*`;
  }
  return new Response(body as Uint8Array<ArrayBuffer>, { status: range ? 206 : 200, headers });
}
