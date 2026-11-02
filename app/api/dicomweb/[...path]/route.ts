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
// Bytes (docs/VIEWER_BENCHMARK.md §6 has the measurements):
//   1. Frames are requested from the archive in lossless JPEG-LS when the
//      browser asked for "whatever is stored" (lib/frameTransfer.ts), ~3.2×
//      fewer bytes, decoded by the loader's worker pool. A refusal falls back
//      to the stored syntax for that series.
//   2. Series metadata is cut to the tags a viewer reads (lib/dicomMetaSlim.ts):
//      9.5 MB → under 1 MB, cached, and gzip/brotli on the wire.
//   3. Every JSON body is compressed when the browser accepts it.
//
// Caching:
//   1. Browser Cache-Control on successful frames (immutable) + short TTL on
//      metadata. Marked `private` — these are per-tenant bytes, never
//      shared-cacheable. 4xx/5xx are not cached: a prefetch 400 must not
//      become the viewer's answer on the next scroll.
//   2. Server cache for frames, thumbnails and slim series indexes
//      (lib/frameCache.ts): in-process LRU, then R2/GCS when configured.
//      Reads are hedged against the archive. Every response says what
//      happened in `X-Cache: HIT | MISS | BYPASS` (+ `X-Cache-Tier`).

import { NextRequest } from "next/server";
import { brotliCompressSync, constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import { responseCacheControl, upstreamAccept, varyHeaderForDicomwebPath } from "@/lib/dicomwebProxy";
import { slimSeriesMetadata, SLIM_META_VERSION } from "@/lib/dicomMetaSlim";
import { cacheGet, cachePut, frameCacheEnabled, type CachedBody } from "@/lib/frameCache";
import {
  FRAME_SYNTAXES,
  acceptsAnySyntax,
  frameAcceptFor,
  isTranscodeRefusal,
  preferredFrameSyntax,
  seriesKeyForFramePath,
  type FrameSyntax,
} from "@/lib/frameTransfer";
import { imagingBackend } from "@/lib/imagingBackend";
import { dicomWebRoot, imagingAuthHeader, orthancConfigured } from "@/lib/orthanc";
import { authorizeStudyRead } from "@/lib/studyAccess";
import { createTtlMemo } from "@/lib/ttlMemo";

/**
 * How long a cache read runs alone before the archive request also starts.
 * After that both race; a late cache hit still wins if it beats the archive.
 */
const CACHE_HEDGE_MS = Number(process.env.FRAME_CACHE_HEDGE_MS ?? process.env.FRAME_CACHE_WAIT_MS ?? 120);
/** Slim series index freshness. A series that gains instances shows them after this. */
const SERIES_INDEX_TTL_MS = Number(process.env.SERIES_INDEX_TTL_MS ?? 60 * 60 * 1000);

/** Series whose archive refused the compressed syntax → ask for "as stored". */
const transcodeRefused = createTtlMemo<true>({ ttlMs: 10 * 60 * 1000, maxEntries: 5_000 });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function applyResponseCache(headers: Headers, path: string, status: number): void {
  const cc = responseCacheControl(path, status);
  if (cc) headers.set("Cache-Control", cc);
  // Vary only on a body we might store. An error must not be reusable.
  if (status >= 200 && status < 300) {
    const vary = varyHeaderForDicomwebPath(path);
    if (vary) headers.set("Vary", `${vary}, Accept-Encoding`);
  }
}

const safeKey = (path: string) => path.replace(/[^a-zA-Z0-9._-]+/g, "_");

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

type Encoding = "br" | "gzip" | null;
function pickEncoding(acceptEncoding: string | null): Encoding {
  const ae = acceptEncoding ?? "";
  if (/\bbr\b/.test(ae)) return "br";
  if (/\bgzip\b/.test(ae)) return "gzip";
  return null;
}

/** Compress a JSON body for the wire. Small bodies go as-is. */
function encodeJson(raw: Buffer, encoding: Encoding, headers: Headers): Buffer {
  if (!encoding || raw.length < 1024) return raw;
  headers.set("Content-Encoding", encoding);
  return encoding === "br"
    ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
    : gzipSync(raw, { level: 6 });
}

/**
 * Hedged read: the cache alone for CACHE_HEDGE_MS, then cache vs archive.
 * `archive` is only started if the cache has not answered with a hit.
 */
async function hedged<T>(
  read: Promise<CachedBody | null>,
  archive: () => Promise<T>
): Promise<{ hit: CachedBody } | { miss: T }> {
  const early = await Promise.race([
    read,
    new Promise<"slow">((resolve) => setTimeout(() => resolve("slow"), CACHE_HEDGE_MS)),
  ]);
  if (early && early !== "slow") return { hit: early };
  if (early === null) return { miss: await archive() };
  // Slow cache: race it against the archive, but a cache MISS must not win.
  const upstream = archive();
  const cacheHit = read.then((v) => (v ? v : new Promise<never>(() => {})));
  const winner = await Promise.race([
    cacheHit.then((hit) => ({ hit }) as const),
    upstream.then((miss) => ({ miss }) as const),
  ]);
  return winner;
}

async function archiveFetch(target: string, accept: string | undefined, method: string) {
  const headers: Record<string, string> = { Authorization: await imagingAuthHeader() };
  if (accept) headers["Accept"] = accept;
  return fetch(target, { method, headers, cache: "no-store" });
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

  const access = await authorizeStudyRead(req, studyUid);
  if (!access.ok) {
    return new Response(access.status === 401 ? "Unauthorized" : "Not found", {
      status: access.status,
    });
  }

  const path = segments.join("/");
  const search = req.nextUrl.search || "";
  const target = `${dicomWebRoot()}/${path}${search}`;
  const isGet = req.method === "GET";
  const isFrame = /\/frames\/\d+$/i.test(path);
  const isRendered = /\/rendered$/i.test(path);
  const isSeriesIndex = /\/series\/[^/]+\/metadata$/i.test(path) && !search;

  if (isGet && !search && isFrame) return frameResponse(req, path, target);
  if (isGet && !search && isRendered) return renderedResponse(req, path, target);
  if (isGet && isSeriesIndex) return seriesIndexResponse(req, path, target);

  // Everything else: QIDO lists, one instance's metadata. Stream non-JSON;
  // compress JSON.
  const resp = await archiveFetch(target, upstreamAccept(path, req.headers.get("accept")), req.method);
  const outHeaders = new Headers();
  const ct = resp.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  applyResponseCache(outHeaders, path, resp.status);
  outHeaders.set("X-Cache", "BYPASS");
  if (isGet && resp.ok && ct && /json/i.test(ct)) {
    const raw = Buffer.from(await resp.arrayBuffer());
    const body = encodeJson(raw, pickEncoding(req.headers.get("accept-encoding")), outHeaders);
    return new Response(new Uint8Array(body), { status: resp.status, headers: outHeaders });
  }
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

function cachedResponse(hit: CachedBody, path: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": hit.contentType || "application/octet-stream" });
  applyResponseCache(headers, path, 200);
  headers.set("X-Cache", "HIT");
  headers.set("X-Cache-Tier", hit.tier);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(new Uint8Array(hit.bytes), { status: 200, headers });
}

async function frameResponse(req: NextRequest, path: string, target: string): Promise<Response> {
  const seriesKey = seriesKeyForFramePath(path);
  const incoming = req.headers.get("accept");
  const preferred = preferredFrameSyntax(imagingBackend(), process.env.DICOMWEB_FRAME_TRANSFER_SYNTAX);
  let syntax: FrameSyntax =
    acceptsAnySyntax(incoming) && preferred.uid && !(seriesKey && transcodeRefused.get(seriesKey))
      ? preferred
      : FRAME_SYNTAXES.original;
  // A caller that asked for a specific syntax gets exactly what it asked for.
  const explicitAccept = !acceptsAnySyntax(incoming) ? upstreamAccept(path, incoming) : undefined;
  const key = () => `frames/${explicitAccept ? "explicit" : syntax.name}/${safeKey(path)}`;
  const enabled = frameCacheEnabled();

  const fetchFrame = async () => {
    let resp = await archiveFetch(target, explicitAccept ?? frameAcceptFor(syntax), "GET");
    if (!resp.ok && !explicitAccept && syntax.uid && isTranscodeRefusal(resp.status)) {
      // This archive/series cannot give us the compressed syntax. Remember,
      // and take what is stored.
      await resp.body?.cancel().catch(() => undefined);
      if (seriesKey) transcodeRefused.set(seriesKey, true);
      syntax = FRAME_SYNTAXES.original;
      resp = await archiveFetch(target, frameAcceptFor(syntax), "GET");
    }
    return resp;
  };

  const syntaxHeader = () => ({ "X-Frame-Syntax": explicitAccept ? "explicit" : syntax.name });

  if (!enabled) {
    const resp = await fetchFrame();
    const headers = new Headers();
    const ct = resp.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    applyResponseCache(headers, path, resp.status);
    headers.set("X-Cache", "BYPASS");
    for (const [k, v] of Object.entries(syntaxHeader())) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
  }

  const result = await hedged(cacheGet(key()), fetchFrame);
  if ("hit" in result) return cachedResponse(result.hit, path, syntaxHeader());
  const resp = result.miss;
  const headers = new Headers();
  const ct = resp.headers.get("content-type") || "application/octet-stream";
  headers.set("content-type", ct);
  applyResponseCache(headers, path, resp.status);
  for (const [k, v] of Object.entries(syntaxHeader())) headers.set(k, v);
  if (!resp.ok) {
    headers.set("X-Cache", "BYPASS");
    return new Response(resp.body, { status: resp.status, headers });
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  cachePut(key(), buf, ct);
  headers.set("X-Cache", "MISS");
  return new Response(new Uint8Array(buf), { status: resp.status, headers });
}

async function renderedResponse(req: NextRequest, path: string, target: string): Promise<Response> {
  const accept = upstreamAccept(path, req.headers.get("accept"));
  const key = `rendered/${safeKey(accept ?? "")}/${safeKey(path)}`;
  const fetchIt = () => archiveFetch(target, accept, "GET");
  const result = frameCacheEnabled()
    ? await hedged(cacheGet(key), fetchIt)
    : { miss: await fetchIt() };
  if ("hit" in result) return cachedResponse(result.hit, path);
  const resp = result.miss;
  const headers = new Headers();
  const ct = resp.headers.get("content-type") || "image/jpeg";
  headers.set("content-type", ct);
  applyResponseCache(headers, path, resp.status);
  if (!resp.ok || !frameCacheEnabled()) {
    headers.set("X-Cache", "BYPASS");
    return new Response(resp.body, { status: resp.status, headers });
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  cachePut(key, buf, ct);
  headers.set("X-Cache", "MISS");
  return new Response(new Uint8Array(buf), { status: 200, headers });
}

/**
 * Series metadata as a slim, cached, compressed index. The cached object is
 * the gzip of the slim JSON; its content type carries when it was built so a
 * stale index is rebuilt after SERIES_INDEX_TTL_MS.
 */
async function seriesIndexResponse(req: NextRequest, path: string, target: string): Promise<Response> {
  const key = `series-index/v${SLIM_META_VERSION}/${safeKey(path)}.json.gz`;
  const encoding = pickEncoding(req.headers.get("accept-encoding"));
  const respond = (gz: Buffer, cache: "HIT" | "MISS", tier?: string) => {
    const headers = new Headers({ "content-type": "application/dicom+json" });
    applyResponseCache(headers, path, 200);
    headers.set("X-Cache", cache);
    if (tier) headers.set("X-Cache-Tier", tier);
    headers.set("X-Series-Index", `slim-v${SLIM_META_VERSION}`);
    if (encoding === "gzip" || encoding === "br") {
      // gzip is what we store; serve it as-is (br would cost a recompress).
      headers.set("Content-Encoding", "gzip");
      return new Response(new Uint8Array(gz), { status: 200, headers });
    }
    return new Response(new Uint8Array(gunzipSync(gz)), { status: 200, headers });
  };

  const build = async (): Promise<Response | Buffer> => {
    const resp = await archiveFetch(target, "application/dicom+json", "GET");
    if (!resp.ok) return resp;
    const full = (await resp.json()) as unknown;
    return gzipSync(Buffer.from(JSON.stringify(slimSeriesMetadata(full))), { level: 6 });
  };

  if (frameCacheEnabled()) {
    const read = cacheGet(key).then((hit) => {
      if (!hit) return null;
      const builtAt = Number(/built=(\d+)/.exec(hit.contentType)?.[1] ?? 0);
      return Date.now() - builtAt < SERIES_INDEX_TTL_MS ? hit : null;
    });
    const result = await hedged(read, build);
    if ("hit" in result) return respond(result.hit.bytes, "HIT", result.hit.tier);
    if (!Buffer.isBuffer(result.miss)) {
      const headers = new Headers({ "X-Cache": "BYPASS" });
      return new Response(result.miss.body, { status: result.miss.status, headers });
    }
    cachePut(key, result.miss, `application/gzip; built=${Date.now()}`);
    return respond(result.miss, "MISS");
  }
  const built = await build();
  if (!Buffer.isBuffer(built)) return new Response(built.body, { status: built.status });
  const res = respond(built, "MISS");
  res.headers.set("X-Cache", "BYPASS");
  return res;
}

// Read-only by design: no POST/PUT export. Ingest goes through /api/upload so
// the de-id gate in `orthancIngestInstance` cannot be bypassed.
export const GET = handle;
export const HEAD = handle;
