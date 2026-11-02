// ============================================================================
// lib/dicomCdn/cornerstoneBridge.ts  (browser only)
//
// Puts converted bundles behind Cornerstone WITHOUT changing a single imageId.
//
// The viewer keeps its `wadors:/api/dicomweb/.../frames/1` imageIds — so
// stored slice indexes, SOP lookups, annotations, teach scripts and MPR all
// stay exactly as they are. This module wraps the registered `wadors` image
// loader: when an imageId belongs to an attached bundle it is served from the
// bundle, otherwise (or on any failure) the original DICOMweb loader runs.
//
//   stack request, full frame not here yet  → 8-bit preview, decoded through
//       Cornerstone's own createImage as an uncompressed frame with the real
//       metadata (lib/dicomCdn/windowing.previewToStoredBytes). Marked
//       `imageQualityStatus = LOSSY` and `radlearnPreview = true`.
//   full chunk arrives                      → the cached preview is dropped;
//       if a stack viewport is showing it, the full frame is decoded and put
//       on screen in place (same camera, same window).
//   volume request (MPR)                    → full frames only, never a preview
//       baked into a volume.
// ============================================================================

import { TS_EXPLICIT_LE, TS_HTJ2K_LOSSLESS_RPCL } from "./format";
import { decodePreviewGrey, type SeriesBundle } from "./client";
import { describePixels, previewToStoredBytes } from "./windowing";

/* Minimal structural types — the bridge must not pull Cornerstone into SSR. */
type AnyImage = Record<string, unknown> & { imageId?: string; radlearnPreview?: boolean };
type LoadObject = { promise: Promise<unknown>; cancelFn?: () => void };
type Loader = (imageId: string, options?: Record<string, unknown>) => LoadObject;

interface StackViewportLike {
  type?: string;
  useCPURendering?: boolean;
  renderImageObject?: (image: unknown) => void;
  element?: HTMLElement;
  getCurrentImageId?: () => string | undefined;
  getProperties?: () => { voiRange?: { lower: number; upper: number } };
  setProperties?: (p: { voiRange?: { lower: number; upper: number } }) => void;
  successCallback?: (imageId: string, image: unknown) => void;
  render?: () => void;
}

export interface CoreLike {
  registerImageLoader: (scheme: string, loader: Loader) => void;
  imageLoader: { loadAndCacheImage: (imageId: string, options?: Record<string, unknown>) => Promise<unknown> };
  cache: {
    getImage: (imageId: string, minQuality?: number) => AnyImage | undefined;
    removeImageLoadObject: (imageId: string, opts?: { force?: boolean }) => void;
  };
  getRenderingEngines?: () => Array<{ getViewports: () => StackViewportLike[] }> | undefined;
  Enums: {
    ImageQualityStatus?: { LOSSY: number; FULL_RESOLUTION: number };
    RequestType?: { Interaction: string };
  };
}

export interface DicomLoaderLike {
  wadors: {
    loadImage: Loader;
    metaDataManager: { add: (imageId: string, meta: never) => void; get: (imageId: string) => unknown };
  };
  createImage: (imageId: string, pixelData: Uint8Array, transferSyntax: string, options?: Record<string, unknown>) => Promise<unknown>;
  decodeImageFrame?: (
    imageFrame: Record<string, unknown>,
    transferSyntax: string,
    pixelData: Uint8Array,
    canvas: unknown,
    options?: Record<string, unknown>,
    decodeConfig?: Record<string, unknown>
  ) => Promise<unknown>;
}

/**
 * 8×8 signed 16-bit lossless HTJ2K codestream (made by lib/dicomCdn/encode).
 * Decoded once per worker at install so the first REAL full-quality frame
 * does not also pay for compiling OpenJPH's WASM inside the decode worker.
 */
const HTJ2K_WARM_FRAME =
  "/0//UQApQAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAABjwEB/1AACAACAAAADP9SAAwAAgABAAUEBEAB/1wAEyCQmJigmJigmJigmJiYkJCY/2QAFwABT3BlbkpQSCBWZXIgMC4xNS4wLv9VAAoAYAAAAAAAUf+QAAoAAAAAAFEAAf+TwAASgPcAB3QAAADAAAlgAASg+gDHdADaAQd0AMAACWAABMDkAEJ0AGr1ACNUAMAAEsAAFSAAqeJ0AK5z7sAAAey2AP/Z";

function warmHtj2kDecoder(loader: DicomLoaderLike, workers: number): void {
  if (!loader.decodeImageFrame) return;
  const bytes = Uint8Array.from(atob(HTJ2K_WARM_FRAME), (c) => c.charCodeAt(0));
  const frame = {
    rows: 8,
    columns: 8,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    pixelRepresentation: 1,
    samplesPerPixel: 1,
    photometricInterpretation: "MONOCHROME2",
    planarConfiguration: 0,
  };
  // Leave one worker cold: the opening PREVIEW decodes (uncompressed) right
  // after install, and must not queue behind a WASM compile.
  for (let i = 0; i < Math.max(1, workers - 1); i++) {
    void loader
      .decodeImageFrame({ ...frame }, TS_HTJ2K_LOSSLESS_RPCL, bytes.slice(), undefined, { priority: -20 }, {})
      .then(() => {
        htj2kReady = true;
      })
      .catch(() => undefined);
  }
}

/** Loader option the bridge sets on its own reloads: never answer with a preview. */
const FULL_ONLY = "radlearnFullOnly";

/** Fired on the viewport element when the frame on screen changes quality. */
export const QUALITY_EVENT = "radlearn:image-quality";

export interface QualityEventDetail {
  imageId: string;
  preview: boolean;
}

interface Attached {
  bundle: SeriesBundle;
  index: number;
}

const registry = new Map<string, Attached>();
let core: CoreLike | null = null;
let dicomLoader: DicomLoaderLike | null = null;
let original: Loader | null = null;
let swapDepth = 0;
/** Slices either side of the reader whose preview is re-decoded at full quality on arrival. */
const NEARBY_REDECODE = 12;
let decodeWorkers = 2;
let decoderWarmed = false;
/**
 * True once any HTJ2K frame has decoded in a worker. Until then the FIRST
 * full-quality decode also compiles OpenJPH's WASM (~100–250 ms), so the
 * opening slice paints its preview even when the full frame is already here.
 */
let htj2kReady = false;

const LOSSY = () => core?.Enums.ImageQualityStatus?.LOSSY ?? 7;
const FULL = () => core?.Enums.ImageQualityStatus?.FULL_RESOLUTION ?? 8;

/** True while the bridge is replacing a preview in place (not a navigation). */
export function isQualitySwap(): boolean {
  return swapDepth > 0;
}

export function isPreviewImage(image: unknown): boolean {
  return Boolean(image && typeof image === "object" && (image as AnyImage).radlearnPreview);
}

/** Which path produced a decoded image: a converted bundle, or DICOMweb. */
export function imageSource(image: unknown): "bundle" | "dicomweb" {
  if (!image || typeof image !== "object") return "dicomweb";
  const img = image as AnyImage;
  return img.radlearnPreview || img.radlearnSource === "bundle" ? "bundle" : "dicomweb";
}

/**
 * Wrap the `wadors` loader once per page. Call after dicom-image-loader init
 * (which registers the original). Idempotent.
 */
export function installBundleLoader(
  coreModule: CoreLike,
  loaderModule: DicomLoaderLike,
  opts: { decodeWorkers?: number } = {}
): void {
  if (original) return;
  core = coreModule;
  dicomLoader = loaderModule;
  original = loaderModule.wadors.loadImage;
  coreModule.registerImageLoader("wadors", bundleAwareLoader);
  decodeWorkers = opts.decodeWorkers ?? 2;
}

/**
 * Serve `imageIds[i]` from `bundle` (same order as bundle.index.sops).
 * Returns a detach function; detaching leaves already-cached images alone.
 */
export function attachBundle(bundle: SeriesBundle, imageIds: readonly string[]): () => void {
  imageIds.forEach((imageId, index) => registry.set(imageId, { bundle, index }));
  const off = bundle.onFrames((kind, indexes) => {
    if (kind !== "full") return;
    for (const i of indexes) {
      const imageId = imageIds[i];
      if (imageId) upgrade(imageId);
    }
  });
  return () => {
    off();
    for (const imageId of imageIds) {
      if (registry.get(imageId)?.bundle !== bundle) continue;
      registry.delete(imageId);
      // A preview left in the decoded cache would outlive the bundle that can
      // upgrade it. Drop it; the next visit loads full quality.
      try {
        if (core?.cache.getImage(imageId)?.radlearnPreview) {
          core.cache.removeImageLoadObject(imageId, { force: true });
        }
      } catch {
        /* already evicted */
      }
    }
  };
}

function bundleAwareLoader(imageId: string, options: Record<string, unknown> = {}): LoadObject {
  const hit = registry.get(imageId);
  if (!hit || !original) return original!(imageId, options);
  const fallback = original;
  // Volumes (MPR), other non-display loads, and the bridge's own upgrade
  // reloads get full frames only.
  const allowPreview = !options.targetBuffer && !options.skipCreateImage && !options[FULL_ONLY];
  const promise = fromBundle(hit, imageId, options, allowPreview).catch((err) => {
    console.warn("[radlearn] bundle frame failed, using DICOMweb", { imageId, err });
    registry.delete(imageId);
    return fallback(imageId, options).promise;
  });
  return { promise, cancelFn: undefined };
}

async function ensureMetadata(imageId: string, { bundle, index }: Attached): Promise<unknown> {
  const manager = dicomLoader!.wadors.metaDataManager;
  const known = manager.get(imageId);
  if (known) return known;
  let meta = bundle.metadataFor(index);
  if (!meta) {
    await bundle.ensurePreviewChunk(index).catch(() => undefined);
    meta = bundle.metadataFor(index);
  }
  if (!meta) meta = (await bundle.allMetadata())[index];
  if (!meta) throw new Error("No metadata for slice");
  manager.add(imageId, meta as never);
  return meta;
}

async function fromBundle(
  hit: Attached,
  imageId: string,
  options: Record<string, unknown>,
  allowPreview: boolean
): Promise<unknown> {
  const { bundle, index } = hit;
  const interactive = options.requestType === (core?.Enums.RequestType?.Interaction ?? "interaction");
  if (interactive) bundle.focus(index);
  const meta = await ensureMetadata(imageId, hit);
  const started = performance.now();

  if (allowPreview && (!bundle.hasFull(index) || !htj2kReady)) {
    await bundle.ensurePreviewChunk(index).catch(() => undefined);
    const preview = bundle.hasFull(index) && htj2kReady ? null : bundle.preview(index);
    const desc = preview ? describePixels(meta) : null;
    if (preview && desc && desc.samplesPerPixel === 1) {
      const grey = await decodePreviewGrey(preview);
      const raw = previewToStoredBytes(grey, preview.w, preview.h, desc, preview.lo, preview.hi);
      const image = (await dicomLoader!.createImage(imageId, raw, TS_EXPLICIT_LE, options)) as AnyImage;
      image.imageQualityStatus = LOSSY();
      image.radlearnPreview = true;
      image.radlearnSource = "bundle";
      image.loadTimeInMS = performance.now() - started;
      // The first preview is decoded: now (not at install, where it would
      // delay this preview) compile the HTJ2K decoder in the other workers,
      // while the opening slice's full frame is still on the wire.
      if (!decoderWarmed) {
        decoderWarmed = true;
        warmHtj2kDecoder(dicomLoader!, decodeWorkers);
      }
      // The full frame may have landed while the preview decoded.
      if (bundle.hasFull(index)) setTimeout(() => upgrade(imageId), 0);
      return image;
    }
  }

  const frame = await bundle.fullFrame(index);
  // createImage may transfer the buffer to a decode worker; keep ours intact.
  const image = (await dicomLoader!.createImage(
    imageId,
    frame.bytes.slice(),
    frame.transferSyntaxUID,
    options
  )) as AnyImage;
  if (frame.transferSyntaxUID === TS_HTJ2K_LOSSLESS_RPCL) htj2kReady = true;
  image.imageQualityStatus = FULL();
  image.radlearnSource = "bundle";
  image.transferSyntaxUID = frame.transferSyntaxUID;
  image.loadTimeInMS = performance.now() - started;
  return image;
}

function viewportsShowing(imageId: string): StackViewportLike[] {
  const out: StackViewportLike[] = [];
  for (const engine of core?.getRenderingEngines?.() ?? []) {
    for (const vp of engine.getViewports()) {
      if (typeof vp.successCallback !== "function") continue;
      try {
        if (vp.getCurrentImageId?.() === imageId) out.push(vp);
      } catch {
        /* destroyed viewport */
      }
    }
  }
  return out;
}

/** Replace a cached preview with the full frame; repaint where it is on screen. */
function upgrade(imageId: string): void {
  if (!core) return;
  const cached = core.cache.getImage(imageId);
  if (!cached || !cached.radlearnPreview) return;
  const showing = viewportsShowing(imageId);
  try {
    core.cache.removeImageLoadObject(imageId, { force: true });
  } catch {
    return;
  }
  if (showing.length === 0) {
    // Near the reader: decode the full frame now so scrolling back is a
    // cache hit, not a decode. Far away: the next visit loads it.
    const hit = registry.get(imageId);
    if (hit && Math.abs(hit.index - hit.bundle.currentIndex) <= NEARBY_REDECODE) {
      void core.imageLoader
        .loadAndCacheImage(imageId, { priority: 0, requestType: "prefetch", [FULL_ONLY]: true })
        .catch(() => undefined);
    }
    return;
  }
  void core.imageLoader
    .loadAndCacheImage(imageId, {
      priority: -10,
      requestType: core.Enums.RequestType?.Interaction ?? "interaction",
      [FULL_ONLY]: true,
    })
    .then((image) => {
      for (const vp of showing) {
        if (vp.getCurrentImageId?.() !== imageId) continue;
        const before = vp.getProperties?.().voiRange;
        swapDepth += 1;
        try {
          if (vp.useCPURendering && vp.renderImageObject) {
            // CPU fallback (no WebGL): successCallback drives the GPU actor.
            vp.renderImageObject(image);
            vp.render?.();
          } else {
            vp.successCallback!(imageId, image);
          }
          const after = vp.getProperties?.().voiRange;
          if (
            before &&
            after &&
            (Math.abs(before.lower - after.lower) > 0.5 || Math.abs(before.upper - after.upper) > 0.5)
          ) {
            vp.setProperties?.({ voiRange: before });
            vp.render?.();
          }
        } finally {
          swapDepth -= 1;
        }
        vp.element?.dispatchEvent(
          new CustomEvent<QualityEventDetail>(QUALITY_EVENT, { detail: { imageId, preview: false } })
        );
      }
    })
    .catch(() => undefined);
}
