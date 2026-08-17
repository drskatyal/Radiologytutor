// Same-origin proxy to Orthanc's DICOMweb endpoint (/dicom-web/...).
// The Cornerstone viewer fetches `wadors:/api/dicomweb/...` so the browser
// only ever hits our own origin — no CORS, and Orthanc's Basic-auth creds
// stay server-side. Streams responses through unchanged (incl. multipart
// pixel data) so WADO-RS works end to end.
//
// Caching: immutable pixel/frame URLs get long-lived Cache-Control so the
// browser (and a CDN later) can warm hot slices. Metadata stays fresher.

import { NextRequest } from "next/server";
import { orthancBase, orthancAuthHeader, orthancConfigured } from "@/lib/orthanc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pixel / rendered frame paths are content-addressed by SOP UID — cache hard. */
function cacheControlForPath(path: string): string | null {
  // .../instances/{sop}/frames/{n} or .../rendered
  if (/\/frames\/\d+/i.test(path) || /\/rendered$/i.test(path)) {
    return "public, max-age=86400, stale-while-revalidate=604800, immutable";
  }
  // Series/study metadata — short TTL so new uploads show up.
  if (/\/metadata$/i.test(path) || /\/series(\/|$)/i.test(path)) {
    return "public, max-age=60, stale-while-revalidate=300";
  }
  return null;
}

async function handle(req: NextRequest, ctx: { params: { path: string[] } }) {
  if (!orthancConfigured()) {
    return new Response("Orthanc backend not configured (set ORTHANC_URL).", { status: 503 });
  }
  const path = ctx.params.path.join("/");
  const search = req.nextUrl.search || "";
  const target = `${orthancBase()}/dicom-web/${path}${search}`;

  const headers: Record<string, string> = { Authorization: orthancAuthHeader() };
  const accept = req.headers.get("accept");
  if (accept) headers["Accept"] = accept;

  const init: RequestInit = { method: req.method, headers, cache: "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
    const ct = req.headers.get("content-type");
    if (ct) headers["Content-Type"] = ct;
  }

  const resp = await fetch(target, init);
  const outHeaders = new Headers();
  const ct = resp.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  if (req.method === "GET" || req.method === "HEAD") {
    const cc = cacheControlForPath(path);
    if (cc) outHeaders.set("Cache-Control", cc);
  }
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

export const GET = handle;
export const POST = handle;
