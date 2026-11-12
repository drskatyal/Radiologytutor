// ============================================================================
// lib/dicomCdn/manifest.ts  (server only)
//
// What GET /api/dicom-cdn/manifest answers once the caller is authorised for
// the study: the series' bundle index plus HOW to fetch its chunks —
//
//   cdn    absolute Cloud CDN prefix + a short-lived URL-prefix signature that
//          covers exactly this series version and nothing else.
//   proxy  same-origin /api/dicom-cdn/files/... (session-checked per request).
//
// Unavailable (feature off, not converted yet, multi-frame) is a normal answer
// — the viewer reads DICOMweb, exactly as before this feature existed.
// ============================================================================

import { createTtlMemo } from "../ttlMemo";
import { dicomCdnConfig } from "./config";
import { isUsableIndex, versionPrefix, type SeriesBundleIndex } from "./format";
import { ensureSeriesBundle } from "./jobs";
import { readSeriesIndex } from "./pack";
import { signCdnUrlPrefix } from "./sign";
import { openBundleStore } from "./store";

export interface BundleDelivery {
  /** Chunk URL = base + file + (query ? "?" + query : ""). */
  base: string;
  query: string;
  mode: "cdn" | "proxy";
  /** Epoch ms after which the client must ask again. */
  expiresAt: number;
}

export type ManifestAnswer =
  | { available: true; index: SeriesBundleIndex; delivery: BundleDelivery }
  | { available: false; reason: "disabled" | "not-converted" | "converting" };

/** Index reads are one small object; memoise briefly (negatives too). */
const indexMemo = createTtlMemo<SeriesBundleIndex | null>({ ttlMs: 20_000, maxEntries: 2_000 });

export async function seriesManifest(study: string, series: string, nowMs = Date.now()): Promise<ManifestAnswer> {
  const config = dicomCdnConfig();
  if (!config) return { available: false, reason: "disabled" };

  const key = `${study}|${series}`;
  let index = indexMemo.get(key);
  if (index === undefined) {
    let raw: unknown = null;
    try {
      raw = await readSeriesIndex(openBundleStore(config.store), study, series);
    } catch (e) {
      console.warn("[dicom-cdn] index read failed", { series, error: e instanceof Error ? e.message : String(e) });
    }
    index = isUsableIndex(raw) && raw.studyInstanceUID === study && raw.seriesInstanceUID === series ? raw : null;
    indexMemo.set(key, index);
  }
  if (!index) {
    const state = ensureSeriesBundle(study, series);
    return { available: false, reason: state === "skipped" ? "not-converted" : "converting" };
  }

  const dir = versionPrefix(study, series, index.version);
  const expiresAt = nowMs + config.urlTtlSeconds * 1000;
  if (config.delivery.mode === "cdn") {
    const base = `${config.delivery.origin}/${dir}/`;
    return {
      available: true,
      index,
      delivery: {
        mode: "cdn",
        base,
        query: signCdnUrlPrefix(base, config.delivery.key, Math.floor(expiresAt / 1000)),
        expiresAt,
      },
    };
  }
  return {
    available: true,
    index,
    delivery: {
      mode: "proxy",
      base: `/api/dicom-cdn/files/${study}/${series}/${index.version}/`,
      query: "",
      expiresAt,
    },
  };
}

/** Test hook. */
export function resetManifestMemo(): void {
  indexMemo.clear();
}
