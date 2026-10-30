// Same-origin proxy to the imaging archive's DICOMweb endpoint.
// Orthanc: `{ORTHANC_URL}/dicom-web`. Healthcare: the regional dicomWeb root.
// The Cornerstone viewer fetches `wadors:/api/dicomweb/...` so the browser
// only ever hits our own origin — no CORS, and archive credentials stay
// server-side. Streams responses through unchanged (incl. multipart
// pixel data) so WADO-RS works end to end.
//
// ACCESS (CLAUDE.md §4a — everything is scoped by orgId):
//   This route hands out patient pixels. It is READ-ONLY. A signed-in session
//   may read studies its org owns. A case-share cookie (set by visiting
//   `/s/[token]`) may read only the study UIDs that one case names — no
//   account required, and no archive-wide search. Ingest deliberately does
//   NOT live here — it belongs to /api/upload, which runs the de-id gate in
//   `orthancIngestInstance`. Proxying STOW-RS would route around that gate,
//   so no write verb is exported.
//
// Caching:
//   1. Browser Cache-Control on successful frames (immutable) + short TTL on
//      metadata. Marked `private` — these are per-tenant bytes, never
//      shared-cacheable. 4xx/5xx are not cached: a prefetch 400 must not
//      become the viewer's answer on the next scroll.
//   2. Optional object cache (Cloudflare R2, or GCS via R2_ENDPOINT) for frame
//      bytes. A miss must not stall the first slice: we only wait
//      FRAME_CACHE_WAIT_MS (default 25) before going to the archive.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { DEFAULT_ORG_ID, getStudyByUID, resolveShareAccess } from "@/lib/cases";
import { SHARE_COOKIE, isShareToken, shareGrantsStudy } from "@/lib/caseShare";
import { responseCacheControl, upstreamAccept, varyHeaderForDicomwebPath } from "@/lib/dicomwebProxy";
import { dicomWebRoot, imagingAuthHeader, orthancConfigured } from "@/lib/orthanc";
import { getObject, putObject, r2Configured, type GetObjectResult } from "@/lib/r2";
import { createTtlMemo } from "@/lib/ttlMemo";

/** How long a frame-cache read may block the archive fetch. 0 skips the read. */
const FRAME_CACHE_WAIT_MS = Number(process.env.FRAME_CACHE_WAIT_MS ?? 25);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function applyResponseCache(headers: Headers, path: string, status: number): void {
  const cc = responseCacheControl(path, status);
  if (cc) headers.set("Cache-Control", cc);
  // Vary only on a body we might store. An error must not be reusable.
  if (status >= 200 && status < 300) {
    const vary = varyHeaderForDicomwebPath(path);
    if (vary) headers.set("Vary", vary);
  }
}

/** R2 key for a frame path — null when the path is not a cacheable frame. */
function frameCacheKey(path: string): string | null {
  if (!/\/frames\/\d+/i.test(path) && !/\/rendered$/i.test(path)) return null;
  return `frames/${path.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
}

/**
 * Frame-path memos (`lib/ttlMemo.ts`). This route runs once per FRAME: a
 * reader scrolling a 500-slice CT asks these three questions 500 times in a
 * few seconds, and all three answers are stable for the length of a scroll.
 * Negative results are cached too, so a loop probing study UIDs it does not
 * own stays cheap.
 *
 *   session   who is calling + which org. A Better Auth session read plus a
 *             domain-user read, keyed on the exact Cookie header so any change
 *             to any cookie is a miss. SHORT ttl: a revoked session keeps
 *             reading pixels for at most this long, which is why it is an
 *             order of magnitude tighter than the other two and tunable.
 *   share     a /s/{token} link's org + study allowlist.
 *   ownership does that org own this study.
 */
const SESSION_TTL_MS = Number(process.env.DICOMWEB_SESSION_TTL_MS ?? 10_000);
const sessionMemo = createTtlMemo<string | null>({
  ttlMs: SESSION_TTL_MS,
  maxEntries: 2_000,
});
const shareMemo = createTtlMemo<{ studyUids: string[] | null; orgId: string }>({
  ttlMs: 60_000,
  maxEntries: 5_000,
});
const ownershipMemo = createTtlMemo<boolean>({ ttlMs: 60_000, maxEntries: 5_000 });

/** Live share → org + study allowlist. Null study list means the token is dead. */
async function shareAllows(token: string, studyUid: string): Promise<string | null> {
  if (!isShareToken(token)) return null;
  let hit = shareMemo.get(token);
  if (!hit) {
    const access = await resolveShareAccess(token);
    hit = {
      orgId: access?.orgId ?? "",
      studyUids: access ? access.studyUids : null,
    };
    shareMemo.set(token, hit);
  }
  if (!hit.studyUids || !shareGrantsStudy(hit.studyUids, studyUid)) return null;
  return hit.orgId || null;
}

/**
 * Active org for the caller, or null when there is no session.
 *
 * Resolves the session ONCE. The previous version called `getSession()` and
 * then `activeOrgId()`, and `activeOrgId()` calls `getSession()` again — two
 * full session resolutions, each a Better Auth read plus a domain-user read,
 * in front of every single frame.
 */
async function callerOrgId(cookieHeader: string): Promise<string | null> {
  const hit = sessionMemo.get(cookieHeader);
  if (hit !== undefined) return hit;
  const session = await getSession();
  const orgId = session ? session.user.activeOrgId || DEFAULT_ORG_ID : null;
  sessionMemo.set(cookieHeader, orgId);
  return orgId;
}

async function orgOwnsStudy(orgId: string, studyUid: string): Promise<boolean> {
  const key = `${orgId}\u0000${studyUid}`;
  const hit = ownershipMemo.get(key);
  if (hit !== undefined) return hit;
  const owned = Boolean(await getStudyByUID(orgId, studyUid));
  ownershipMemo.set(key, owned);
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

  const segments = ctx.params.path;
  const studyUid = studyUidFromPath(segments);

  // A study-addressed request must name a study the caller may see.
  // An unaddressed request (bare QIDO `studies` search) would enumerate the
  // whole archive across tenants, so it is refused outright — callers list
  // studies through /api/admin/studies, which is org-scoped.
  if (!studyUid) {
    return new Response("A StudyInstanceUID is required.", { status: 400 });
  }

  // Share cookie first, and only for the studies that case names. A leftover
  // cookie must not block a signed-in reader of a different study.
  const shareToken = req.cookies.get(SHARE_COOKIE)?.value;
  const shareOrg = shareToken ? await shareAllows(shareToken, studyUid) : null;
  let orgId = shareOrg;
  if (!orgId) {
    orgId = await callerOrgId(req.headers.get("cookie") ?? "");
    if (!orgId) return new Response("Unauthorized", { status: 401 });
  }
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
      outHeaders.set("x-flowrad-cache", "r2");
      applyResponseCache(outHeaders, path, 200);
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
  applyResponseCache(outHeaders, path, resp.status);

  // Buffer frame bodies so we can fill the object cache; stream everything else.
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
