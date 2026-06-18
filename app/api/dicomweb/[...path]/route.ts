// Same-origin proxy to Orthanc's DICOMweb endpoint (/dicom-web/...).
// The Cornerstone viewer fetches `wadors:/api/dicomweb/...` so the browser
// only ever hits our own origin — no CORS, and Orthanc's Basic-auth creds
// stay server-side. Streams responses through unchanged (incl. multipart
// pixel data) so WADO-RS works end to end.

import { NextRequest } from "next/server";
import { orthancBase, orthancAuthHeader, orthancConfigured } from "@/lib/orthanc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

export const GET = handle;
export const POST = handle;
