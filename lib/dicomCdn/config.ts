// ============================================================================
// lib/dicomCdn/config.ts  (server only)
//
// Environment for converted-DICOM delivery. Everything is optional: with
// nothing set the feature is off and the viewer reads DICOMweb exactly as
// before. Nothing here is ever sent to the browser except the public CDN host.
//
//   DICOM_CDN_BUCKET           Private GCS bucket for converted series (prod).
//   DICOM_CDN_LOCAL_DIR        Directory store instead of a bucket (dev, tests).
//   DICOM_CDN_URL              https origin of the Cloud CDN load balancer that
//                              fronts the bucket. Unset → chunks are served by
//                              the app at /api/dicom-cdn/files (same auth as
//                              /api/dicomweb), still batched and HTJ2K.
//   DICOM_CDN_KEY_NAME         Cloud CDN signed-URL key name.     } both or
//   DICOM_CDN_KEY              base64url key (Secret Manager).    } neither
//   DICOM_CDN_URL_TTL_SECONDS  Signed prefix lifetime (default 3600, 60–43200).
//   DICOM_CDN_BUILD            "auto" (default): convert after upload and on
//                              first view of an unconverted series. "off":
//                              only the backfill script converts.
//   DICOM_CDN_DISABLED         "1" → manifest API says unavailable (kill switch).
// ============================================================================

import type { CdnSigningKey } from "./sign";

export type StoreTarget =
  | { kind: "gcs"; bucket: string }
  | { kind: "local"; dir: string };

export type Delivery =
  | { mode: "cdn"; origin: string; key: CdnSigningKey }
  | { mode: "proxy" };

export interface DicomCdnConfig {
  store: StoreTarget;
  delivery: Delivery;
  urlTtlSeconds: number;
  autoBuild: boolean;
}

export function readDicomCdnConfig(env: NodeJS.ProcessEnv = process.env): DicomCdnConfig | null {
  if (env.DICOM_CDN_DISABLED?.trim() === "1") return null;
  const bucket = env.DICOM_CDN_BUCKET?.trim();
  const dir = env.DICOM_CDN_LOCAL_DIR?.trim();
  let store: StoreTarget | null = null;
  if (bucket) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) {
      throw new Error("DICOM_CDN_BUCKET must be a bare bucket name (no gs://).");
    }
    store = { kind: "gcs", bucket };
  } else if (dir) {
    store = { kind: "local", dir };
  }
  if (!store) return null;

  const origin = env.DICOM_CDN_URL?.trim().replace(/\/+$/, "");
  const keyName = env.DICOM_CDN_KEY_NAME?.trim();
  const key = env.DICOM_CDN_KEY?.trim();
  let delivery: Delivery = { mode: "proxy" };
  if (origin) {
    if (!/^https:\/\//.test(origin)) throw new Error("DICOM_CDN_URL must be an https origin.");
    if (!keyName || !key) {
      // A CDN with no signing key would have to be public. Refuse rather than
      // silently publish pixels.
      throw new Error("DICOM_CDN_URL needs DICOM_CDN_KEY_NAME and DICOM_CDN_KEY (signed access only).");
    }
    delivery = { mode: "cdn", origin, key: { keyName, keyBase64Url: key } };
  }

  const ttlRaw = Number(env.DICOM_CDN_URL_TTL_SECONDS ?? 3600);
  const urlTtlSeconds = Number.isFinite(ttlRaw) ? Math.min(43_200, Math.max(60, Math.round(ttlRaw))) : 3600;
  const autoBuild = (env.DICOM_CDN_BUILD?.trim().toLowerCase() || "auto") !== "off";
  return { store, delivery, urlTtlSeconds, autoBuild };
}

let memo: { value: DicomCdnConfig | null; error: string | null } | null = null;

/** Process config, read once. A misconfiguration disables the feature and logs once. */
export function dicomCdnConfig(): DicomCdnConfig | null {
  if (memo) return memo.value;
  try {
    memo = { value: readDicomCdnConfig(), error: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[dicom-cdn] disabled: ${message}`);
    memo = { value: null, error: message };
  }
  return memo.value;
}

/** Test hook. */
export function resetDicomCdnConfig(): void {
  memo = null;
}
