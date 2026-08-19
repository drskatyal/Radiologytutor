// Same-origin proxy to Orthanc's DICOMweb endpoint (/dicom-web/...).
// The Cornerstone viewer fetches `wadors:/api/dicomweb/...` so the browser
// only ever hits our own origin — no CORS, and Orthanc's Basic-auth creds
// stay server-side. Streams responses through unchanged (incl. multipart
// pixel data) so WADO-RS works end to end.
//
// Caching:
//   1. Browser Cache-Control on frames (immutable) + short TTL on metadata.
//   2. Optional Cloudflare R2 object cache for frame bytes when R2_* is set —
//      cold Fly machines skip Orthanc on repeat opens (≤30s interactive path).

import { NextRequest } from "next/server";
import { orthancBase, orthancAuthHeader, orthancConfigured } from "@/lib/orthanc";
import { getObject, putObject, r2Configured } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pixel / rendered frame paths are content-addressed by SOP UID — cache hard. */
function cacheControlForPath(path: string): string | null {
  if (/\/frames\/\d+/i.test(path) || /\/rendered$/i.test(path)) {
    return "public, max-age=86400, stale-while-revalidate=604800, immutable";
  }
  if (/\/metadata$/i.test(path) || /\/series(\/|$)/i.test(path)) {
    return "public, max-age=60, stale-while-revalidate=300";
  }
  return null;
}

/** R2 key for a frame path — null when the path is not a cacheable frame. */
function frameCacheKey(path: string): string | null {
  if (!/\/frames\/\d+/i.test(path) && !/\/rendered$/i.test(path)) return null;
  return `frames/${path.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
}

async function handle(req: NextRequest, ctx: { params: { path: string[] } }) {
  if (!orthancConfigured()) {
    return new Response("Orthanc backend not configured (set ORTHANC_URL).", { status: 503 });
  }
  const path = ctx.params.path.join("/");
  const search = req.nextUrl.search || "";
  const target = `${orthancBase()}/dicom-web/${path}${search}`;
  const isGet = req.method === "GET" || req.method === "HEAD";
  const r2Key = isGet && !search ? frameCacheKey(path) : null;

  if (r2Key && r2Configured() && req.method === "GET") {
    const hit = await getObject(r2Key).catch(() => null);
    if (hit) {
      const outHeaders = new Headers();
      outHeaders.set("content-type", hit.contentType || "application/octet-stream");
      outHeaders.set("x-flowrad-cache", "r2");
      const cc = cacheControlForPath(path);
      if (cc) outHeaders.set("Cache-Control", cc);
      return new Response(new Uint8Array(hit.bytes), { status: 200, headers: outHeaders });
    }
  }

  const headers: Record<string, string> = { Authorization: orthancAuthHeader() };
  const accept = req.headers.get("accept");
  if (accept) headers["Accept"] = accept;

  const init: RequestInit = { method: req.method, headers, cache: "no-store" };
  if (!isGet) {
    init.body = await req.arrayBuffer();
    const ct = req.headers.get("content-type");
    if (ct) headers["Content-Type"] = ct;
  }

  const resp = await fetch(target, init);
  const outHeaders = new Headers();
  const ct = resp.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  if (isGet) {
    const cc = cacheControlForPath(path);
    if (cc) outHeaders.set("Cache-Control", cc);
  }

  // Buffer frame bodies so we can fill R2; stream everything else.
  if (r2Key && r2Configured() && req.method === "GET" && resp.ok) {
    const buf = Buffer.from(await resp.arrayBuffer());
    void putObject(r2Key, buf, ct || "application/octet-stream").catch(() => undefined);
    outHeaders.set("x-flowrad-cache", "miss");
    return new Response(buf, { status: resp.status, headers: outHeaders });
  }

  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

export const GET = handle;
export const POST = handle;
