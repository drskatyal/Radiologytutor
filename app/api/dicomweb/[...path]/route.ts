// Same-origin proxy to Orthanc's DICOMweb endpoint (/dicom-web/...).
// The Cornerstone viewer fetches `wadors:/api/dicomweb/...` so the browser
// only ever hits our own origin — no CORS, and Orthanc's Basic-auth creds
// stay server-side. Streams responses through unchanged (incl. multipart
// pixel data) so WADO-RS works end to end.
//
// ACCESS (CLAUDE.md §4a — everything is scoped by orgId):
//   This route hands out patient pixels. It is READ-ONLY and requires a
//   session; study-addressed paths are additionally checked against the
//   caller's org, so one tenant can never pull another tenant's imaging.
//   Ingest deliberately does NOT live here — it belongs to /api/upload, which
//   runs the de-id gate in `orthancIngestInstance`. Proxying STOW-RS would
//   route around that gate, so no write verb is exported.
//
// Caching:
//   1. Browser Cache-Control on frames (immutable) + short TTL on metadata.
//      Marked `private` — these are per-tenant bytes, never shared-cacheable,
//      and never a public CDN.
//   2. Optional object cache (R2, or GCS via R2_ENDPOINT) for frame bytes.
//      A miss must not stall first-slice: we only wait FRAME_CACHE_WAIT_MS
//      (default 25) before going to the archive. Repeat opens still hit.

import { NextRequest } from "next/server";
import { activeOrgId, getSession } from "@/lib/auth";
import { getStudyByUID } from "@/lib/cases";
import { dicomWebRoot, imagingAuthHeader, orthancConfigured, upstreamAccept } from "@/lib/orthanc";
import { getObject, putObject, r2Configured, type GetObjectResult } from "@/lib/r2";

/** How long a frame-cache read may block the archive fetch. 0 skips the read. */
const FRAME_CACHE_WAIT_MS = Number(process.env.FRAME_CACHE_WAIT_MS ?? 25);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pixel / rendered frame paths are content-addressed by SOP UID — cache hard. */
function cacheControlForPath(path: string): string | null {
  if (/\/frames\/\d+/i.test(path) || /\/rendered$/i.test(path)) {
    return "private, max-age=86400, stale-while-revalidate=604800, immutable";
  }
  if (/\/metadata$/i.test(path) || /\/series(\/|$)/i.test(path)) {
    return "private, max-age=60, stale-while-revalidate=300";
  }
  return null;
}

/** R2 key for a frame path — null when the path is not a cacheable frame. */
function frameCacheKey(path: string): string | null {
  if (!/\/frames\/\d+/i.test(path) && !/\/rendered$/i.test(path)) return null;
  return `frames/${path.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
}

/**
 * Org-ownership memo. A single scroll through a series issues one request per
 * frame, and `getStudyByUID` scans the studies collection, so without this the
 * authorization check would dominate the interactive path. Keyed by org+UID,
 * short TTL, negative results cached too so a probing loop stays cheap.
 */
const OWNERSHIP_TTL_MS = 60_000;
const ownershipMemo = new Map<string, { owned: boolean; at: number }>();

async function orgOwnsStudy(orgId: string, studyUid: string): Promise<boolean> {
  const key = `${orgId}\u0000${studyUid}`;
  const hit = ownershipMemo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < OWNERSHIP_TTL_MS) return hit.owned;
  const owned = Boolean(await getStudyByUID(orgId, studyUid));
  ownershipMemo.set(key, { owned, at: now });
  // Bound the map so a long-lived server cannot grow it without limit.
  if (ownershipMemo.size > 5_000) {
    for (const [k, v] of ownershipMemo) {
      if (now - v.at >= OWNERSHIP_TTL_MS) ownershipMemo.delete(k);
    }
  }
  return owned;
}

/**
 * Pull the StudyInstanceUID out of a DICOMweb path.
 * WADO-RS/QIDO-RS address studies as `studies/{uid}/...`; a bare `studies`
 * (the QIDO search) has no UID and returns null.
 */
function studyUidFromPath(segments: string[]): string | null {
  const i = segments.findIndex((s) => s.toLowerCase() === "studies");
  if (i === -1) return null;
  const uid = segments[i + 1];
  return uid && uid.trim() ? decodeURIComponent(uid) : null;
}

async function handle(req: NextRequest, ctx: { params: { path: string[] } }) {
  if (!orthancConfigured()) {
    return new Response(
      "Imaging archive is not configured (set ORTHANC_URL, or DICOMWEB_BACKEND=healthcare).",
      { status: 503 }
    );
  }

  // Imaging is never anonymous.
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const segments = ctx.params.path;
  const studyUid = studyUidFromPath(segments);

  // A study-addressed request must name a study this org actually holds.
  // An unaddressed request (bare QIDO `studies` search) would enumerate the
  // whole archive across tenants, so it is refused outright — callers list
  // studies through /api/admin/studies, which is org-scoped.
  if (!studyUid) {
    return new Response("A StudyInstanceUID is required.", { status: 400 });
  }
  const orgId = await activeOrgId();
  if (!(await orgOwnsStudy(orgId, studyUid))) {
    return new Response("Not found", { status: 404 });
  }

  const path = segments.join("/");
  const search = req.nextUrl.search || "";
  const target = `${dicomWebRoot()}/${path}${search}`;
  const r2Key = !search ? frameCacheKey(path) : null;

  if (r2Key && r2Configured() && FRAME_CACHE_WAIT_MS > 0) {
    const hit = await readFrameCache(r2Key);
    if (hit) {
      const outHeaders = new Headers();
      outHeaders.set("content-type", hit.contentType || "application/octet-stream");
      outHeaders.set("x-flowrad-cache", "hit");
      outHeaders.set("Vary", "Accept");
      const cc = cacheControlForPath(path);
      if (cc) outHeaders.set("Cache-Control", cc);
      return new Response(new Uint8Array(hit.bytes), { status: 200, headers: outHeaders });
    }
  }

  const headers: Record<string, string> = { Authorization: await imagingAuthHeader() };
  const accept = upstreamAccept(path, req.headers.get("accept"));
  if (accept) headers["Accept"] = accept;

  const resp = await fetch(target, { method: req.method, headers, cache: "no-store" });
  const outHeaders = new Headers();
  const ct = resp.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  const cc = cacheControlForPath(path);
  if (cc) outHeaders.set("Cache-Control", cc);
  outHeaders.set("Vary", "Accept");

  // Buffer frame bodies so we can fill R2; stream everything else.
  if (r2Key && r2Configured() && req.method === "GET" && resp.ok) {
    const buf = Buffer.from(await resp.arrayBuffer());
    void putObject(r2Key, buf, ct || "application/octet-stream").catch(() => undefined);
    outHeaders.set("x-flowrad-cache", "miss");
    return new Response(buf, { status: resp.status, headers: outHeaders });
  }

  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

/**
 * Frame-cache read with a short budget. A slow bucket must not sit in front
 * of the first slice; the archive request starts as soon as the budget ends.
 */
function readFrameCache(key: string): Promise<GetObjectResult | null> {
  return Promise.race([
    getObject(key).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FRAME_CACHE_WAIT_MS)),
  ]);
}

// Read-only by design: no POST/PUT export. Ingest goes through /api/upload so
// the de-id gate in `orthancIngestInstance` cannot be bypassed.
export const GET = handle;
export const HEAD = handle;
