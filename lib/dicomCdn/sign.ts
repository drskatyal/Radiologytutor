// ============================================================================
// lib/dicomCdn/sign.ts  (server only — holds the CDN signing key)
//
// Cloud CDN signed URL *prefix*. One signature authorises every object under
// one series' version directory for a short time, so the browser can fetch
// ~100 chunks without ~100 round trips to us. The bucket stays private
// (public access prevention enforced); Cloud CDN checks the signature on every
// request, cache hit or miss, and strips these params from its cache key.
//
// Format (Cloud CDN "Signed URLs", URL-prefix variant):
//   policy    = "URLPrefix=" + base64url(prefix) + "&Expires=" + epoch + "&KeyName=" + name
//   Signature = base64url(HMAC-SHA1(base64url-decoded key, policy))
//   query     = policy + "&Signature=" + Signature
// base64url keeps "=" padding, matching Google's reference samples.
// ============================================================================

import { createHmac } from "node:crypto";

export interface CdnSigningKey {
  keyName: string;
  /** base64url-encoded 16-byte key, as Cloud CDN generates it. */
  keyBase64Url: string;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(text: string): Buffer {
  return Buffer.from(text.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Query string (no leading "?") that authorises GETs under `urlPrefix` until
 * `expiresAtEpochSec`. `urlPrefix` must be the absolute https URL prefix and
 * should end with "/" so it cannot match a sibling directory.
 */
export function signCdnUrlPrefix(
  urlPrefix: string,
  key: CdnSigningKey,
  expiresAtEpochSec: number
): string {
  const encodedPrefix = toBase64Url(Buffer.from(urlPrefix, "utf8"));
  const policy =
    `URLPrefix=${encodedPrefix}` +
    `&Expires=${Math.floor(expiresAtEpochSec)}` +
    `&KeyName=${key.keyName}`;
  const signature = toBase64Url(
    createHmac("sha1", fromBase64Url(key.keyBase64Url)).update(policy, "utf8").digest()
  );
  return `${policy}&Signature=${signature}`;
}
