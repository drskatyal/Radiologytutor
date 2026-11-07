// Which transfer syntax the proxy asks the archive for, per frame.
//
// The Cornerstone wadors loader sends `transfer-syntax=*` ("whatever is
// stored"). Cloud Healthcare stores what was uploaded — usually uncompressed
// little endian — so every 512² CT slice crossed the wire as 512 KB. Asking
// for lossless JPEG-LS instead is ~3.2× fewer bytes on real CT (3.6× on the
// phantom), decoded by CharLS in the loader's web-worker pool. The multipart
// part's Content-Type carries the transfer syntax, so the loader picks the
// right decoder with no client change.
//
// Lossless only: this is a teaching viewer, but the pixels are still the
// pixels. If the archive cannot transcode (a series stored compressed, colour
// > 8-bit, an archive without the codec) it answers 4xx; the proxy then
// retries with `transfer-syntax=*` and remembers that series for a while so
// the next slice does not pay the failed round trip again.

export type FrameSyntaxName = "jls" | "htj2k" | "j2k" | "original";

export interface FrameSyntax {
  name: FrameSyntaxName;
  /** DICOM transfer syntax UID, null for "as stored". */
  uid: string | null;
  /** Single-part media type for the multipart/related body. */
  type: string;
}

export const FRAME_SYNTAXES: Record<FrameSyntaxName, FrameSyntax> = {
  jls: { name: "jls", uid: "1.2.840.10008.1.2.4.80", type: "image/jls" },
  htj2k: { name: "htj2k", uid: "1.2.840.10008.1.2.4.201", type: "image/jphc" },
  j2k: { name: "j2k", uid: "1.2.840.10008.1.2.4.90", type: "image/jp2" },
  original: { name: "original", uid: null, type: "application/octet-stream" },
};

/**
 * `DICOMWEB_FRAME_TRANSFER_SYNTAX` = jls | htj2k | j2k | original.
 * Default: JPEG-LS on Cloud Healthcare (it transcodes), as-stored on Orthanc
 * (only transcodes when built with GDCM, and a 4xx per slice is not worth it).
 */
export function preferredFrameSyntax(
  backend: "orthanc" | "healthcare",
  configured: string | undefined
): FrameSyntax {
  const key = configured?.trim().toLowerCase();
  if (key && key in FRAME_SYNTAXES) return FRAME_SYNTAXES[key as FrameSyntaxName];
  return backend === "healthcare" ? FRAME_SYNTAXES.jls : FRAME_SYNTAXES.original;
}

/** Accept header for a frame request in this syntax (DICOM PS3.18 §8.7.3). */
export function frameAcceptFor(syntax: FrameSyntax): string {
  if (!syntax.uid) return "multipart/related; type=application/octet-stream; transfer-syntax=*";
  return `multipart/related; type="${syntax.type}"; transfer-syntax=${syntax.uid}`;
}

/** Did the browser ask for "whatever is stored" (the loader's default)? */
export function acceptsAnySyntax(accept: string | null | undefined): boolean {
  if (!accept) return true;
  if (!/multipart\/related/i.test(accept)) return true;
  return /transfer-syntax=\*/i.test(accept) || !/transfer-syntax=/i.test(accept);
}

/** Statuses that mean "cannot give you this syntax" rather than "no such frame". */
export function isTranscodeRefusal(status: number): boolean {
  return status === 400 || status === 406 || status === 415 || status === 501;
}

/** Series key for the fallback memo: the frame path up to the series UID. */
export function seriesKeyForFramePath(path: string): string | null {
  const m = /studies\/([^/]+)\/series\/([^/]+)\/instances\//i.exec(path);
  return m ? `${m[1]}/${m[2]}` : null;
}
