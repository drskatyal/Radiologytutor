// Engine knobs for the Cornerstone3D runtime — how many decode workers, how
// much image cache, how many parallel frame requests, and what to tell
// `core.init()` about the device.
//
// These were literals inside `components/CornerstoneViewer.tsx`. They are a
// module because they are device-dependent, they decide how much memory a
// reading session can take, and they need to be the SAME numbers the
// benchmark harness measures (`scripts/bench/harness.ts`). No Cornerstone
// import here — pure arithmetic over a device profile, so it unit-tests.
//
// Library defaults we deliberately override, and why:
//
//   • `maxWebWorkers` — `@cornerstonejs/dicom-image-loader` defaults to
//     `hardwareConcurrency / 2`; the viewer used to pin it at `min(4, cores)`,
//     which capped a 16-core reading station at a quarter of its cores. We
//     take 75% of the cores (leaving the main thread, the compositor and the
//     network stack a quarter) and cap at 8 — past that the frame requests,
//     not the decoders, are the limit.
//     HONESTY NOTE: `scripts/bench/run.mjs` measured NO reliable gain from
//     4 → 7 workers on *uncompressed* 16-bit frames (within noise at both
//     512² and 1024²), because little-endian decode is close to a memcpy.
//     The change is for the transfer syntaxes a real archive actually stores
//     — JPEG 2000 / JPEG-LS / HTJ2K, which decode in WASM and are the case
//     where worker count dominates. See docs/VIEWER_BENCHMARK.md.
//   • `cache.setMaxCacheSize` — Cornerstone defaults to **3 GB** of decoded
//     pixels. The cache evicts LRU, so a smaller ceiling costs re-decodes, not
//     correctness; a 3 GB ceiling on a 4 GB Chromebook or a phone costs the
//     whole tab. We scale with `navigator.deviceMemory`.
//   • `imageRetrievalPoolManager.maxNumRequests` — library default is 6
//     interaction requests. 16 is right on a desktop against our same-origin
//     proxy (Google's own DICOM-viewer guidance moves ~0.5 MB frames from
//     ~30 FPS at 6-wide to ~60 FPS near 20). On a phone on cellular, 16
//     in-flight frame requests just queue behind each other and delay the
//     slice the reader is actually on, so mobile gets a narrower pool.
//   • `core.init({ isMobile })` — Cornerstone allocates **7** WebGL contexts
//     in its context pool by default; passing `isMobile` drops that to 1. On a
//     phone those six spare contexts are pure memory. Also sets
//     `preferSizeOverAccuracy` so 16-bit pixels stay in a native texture
//     format instead of being widened to float32 (half the texture memory;
//     the only device where it costs visible accuracy is high-bit-depth
//     rendering we do not do on phones).

/** What we know about the device before any pixels load. */
export interface DeviceProfile {
  /** Phone/tablet form factor — not merely "has a touchscreen". */
  isMobile: boolean;
  /** Logical cores. 4 when the browser will not say. */
  cores: number;
  /** `navigator.deviceMemory` in GiB, or a conservative 8 when absent. */
  deviceMemoryGb: number;
  /** Primary pointer is a finger/stylus. Drives hit-target sizing, not perf. */
  coarsePointer: boolean;
}

const ONE_MB = 1024 * 1024;

/** Clamp helper — `Math.min`/`Math.max` chains read badly in the formulas. */
function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Read the device profile from the browser. Server-safe: returns a desktop
 * profile when there is no `navigator`, so a server component that imports
 * this module for its types never throws.
 */
export function detectDeviceProfile(): DeviceProfile {
  if (typeof navigator === "undefined") {
    return { isMobile: false, cores: 4, deviceMemoryGb: 8, coarsePointer: false };
  }
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
  };
  const coarsePointer =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false;
  // `userAgentData.mobile` is the only non-sniffing signal, and Safari does
  // not have it. Fall back to coarse pointer AND a small viewport, so a
  // touchscreen laptop is not treated as a phone.
  const smallViewport =
    typeof window !== "undefined" ? Math.min(window.innerWidth, window.innerHeight) < 820 : false;
  const isMobile = nav.userAgentData?.mobile ?? (coarsePointer && smallViewport);
  return {
    isMobile,
    cores: Number.isFinite(nav.hardwareConcurrency) && nav.hardwareConcurrency > 0
      ? nav.hardwareConcurrency
      : 4,
    deviceMemoryGb:
      Number.isFinite(nav.deviceMemory) && (nav.deviceMemory ?? 0) > 0 ? nav.deviceMemory! : 8,
    coarsePointer,
  };
}

/**
 * Decode workers: 75% of the cores on a workstation (capped at 8). A phone
 * keeps the library's own `cores / 2` but caps at 3 — past that the thermal
 * budget goes into decoding slices nobody scrolled to.
 */
export function webWorkerCount(profile: DeviceProfile): number {
  if (profile.isMobile) return clamp(Math.floor(profile.cores / 2), 1, 3);
  return clamp(Math.ceil(profile.cores * 0.75), 2, 8);
}

/**
 * Decoded-pixel cache ceiling, in bytes. A 512×512×16-bit frame is 512 KB, so
 * 1 GB holds about 2000 slices — more than any single series we teach from.
 */
export function imageCacheBytes(profile: DeviceProfile): number {
  if (profile.isMobile) return 192 * ONE_MB;
  if (profile.deviceMemoryGb <= 2) return 256 * ONE_MB;
  if (profile.deviceMemoryGb <= 4) return 512 * ONE_MB;
  if (profile.deviceMemoryGb <= 8) return 1024 * ONE_MB;
  return 2048 * ONE_MB;
}

export interface RetrievalPoolSizes {
  /** Frames the reader is waiting on right now. */
  interaction: number;
  /** Series-rail covers. Must never crowd out the opening frame. */
  thumbnail: number;
  /** Neighbor warm-up. Low so it yields to interaction. */
  prefetch: number;
}

export function retrievalPoolSizes(profile: DeviceProfile): RetrievalPoolSizes {
  if (profile.isMobile) return { interaction: 6, thumbnail: 1, prefetch: 2 };
  return { interaction: 16, thumbnail: 2, prefetch: 4 };
}

/** The subset of Cornerstone's init config we set. Shape, not a library type. */
export interface CoreInitConfig {
  isMobile: boolean;
  gpuTier: { tier: number };
  rendering: {
    preferSizeOverAccuracy: boolean;
  };
}

export function coreInitConfig(profile: DeviceProfile): CoreInitConfig {
  return {
    isMobile: profile.isMobile,
    gpuTier: { tier: profile.isMobile ? 1 : 2 },
    rendering: {
      preferSizeOverAccuracy: profile.isMobile,
    },
  };
}

/** One-line summary for the console/perf log. Keeps the numbers auditable. */
export function describeRuntime(profile: DeviceProfile): string {
  const cache = Math.round(imageCacheBytes(profile) / ONE_MB);
  const pool = retrievalPoolSizes(profile);
  return (
    `${profile.isMobile ? "mobile" : "desktop"} · ${profile.cores} cores · ` +
    `${profile.deviceMemoryGb}GB · ${webWorkerCount(profile)} decode workers · ` +
    `${cache}MB image cache · ${pool.interaction} interactive requests`
  );
}
