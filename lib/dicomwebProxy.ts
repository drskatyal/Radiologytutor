// Header policy for the same-origin DICOMweb proxy.
//
// Orthanc's WADO-RS RetrieveFrames answers 400 unless Accept contains
// multipart/related. The Cornerstone image loader (dicom-image-loader 5.0.10,
// wadors/loadImage) sends the constant below. Prefetch must send the same
// string so a warmed response is the one the viewer will reuse.
//
// Error statuses are not cacheable here. A 400/404 stamped
// `immutable` would stick in the HTTP cache and fail the real scroll later.

/** Exact Accept the Cornerstone wadors loader sends for frame pixels. */
export const WADORS_FRAME_ACCEPT =
  "multipart/related; type=application/octet-stream; transfer-syntax=*";

/**
 * Pixel / rendered frame paths are content-addressed by SOP UID — cache hard.
 * One instance's metadata is too. Series-level metadata and QIDO instance
 * lists can grow, so they get a short private TTL the browser can reuse
 * while the reader is still in the study.
 */
export function cacheControlForDicomwebPath(path: string): string | null {
  const clean = path.split("?")[0] ?? path;
  if (/\/frames\/\d+/i.test(clean) || /\/rendered$/i.test(clean)) {
    return "private, max-age=86400, stale-while-revalidate=604800, immutable";
  }
  if (/\/instances\/[^/]+\/metadata$/i.test(clean)) {
    return "private, max-age=86400, immutable";
  }
  if (
    /\/metadata$/i.test(clean) ||
    /\/instances$/i.test(clean) ||
    /\/series(\/|$)/i.test(clean)
  ) {
    return "private, max-age=300, stale-while-revalidate=3600";
  }
  return null;
}

/**
 * Cache-Control for a proxy response. Only successful bodies are stored.
 * Chrome will cache a 404 that carries `immutable`; a frame that 404s during
 * a prefetch race must not become the viewer's answer for a day.
 */
export function responseCacheControl(path: string, status: number): string | null {
  if (status < 200 || status >= 300) return null;
  return cacheControlForDicomwebPath(path);
}

/** Responses whose bytes depend on Accept. */
export function varyHeaderForDicomwebPath(path: string): string | null {
  if (
    /\/frames\/\d+/i.test(path) ||
    /\/rendered$/i.test(path) ||
    /\/metadata$/i.test(path)
  ) {
    return "Accept";
  }
  return null;
}

/**
 * Accept to forward to Orthanc.
 * Frames without multipart/related are rewritten to the loader's media type
 * so a warmer (or any other caller) cannot trip Orthanc's 400.
 * Rendered thumbnails from an `<img>` send `image/avif` first; Orthanc
 * returns 400 unless jpeg or png is explicit.
 */
export function upstreamAccept(path: string, incoming: string | null): string | undefined {
  const clean = path.split("?")[0] ?? path;
  if (/\/frames\/\d+$/i.test(clean)) {
    if (!incoming || !/multipart\/related/i.test(incoming)) return WADORS_FRAME_ACCEPT;
    return incoming;
  }
  if (/\/rendered$/i.test(clean)) {
    if (incoming && /image\/(jpeg|png|jp2)\b/i.test(incoming)) return incoming;
    return "image/jpeg";
  }
  return incoming ?? undefined;
}
