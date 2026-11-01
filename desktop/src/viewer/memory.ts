// Keep decoded images honest about their memory.
//
// Cornerstone's wadouri loader keeps every file's raw bytes (the parsed DICOM
// dataset) alive for as long as its decoded image sits in the cache, because
// the metadata provider reads tags from it. For an uncompressed 512×512 CT that
// is a second 512 KB per slice the cache budget never counts: an 848-slice
// series held ~0.9 GB instead of ~0.45 GB, and an MPR build doubled again.
//
// Once a single-frame image is decoded, its dataset is trimmed to the bytes
// before Pixel Data: every tag the metadata provider reads keeps its offset,
// only the pixels (already decoded into the image) are dropped. If the decoded
// image is later evicted, the dataset is released completely, so the next load
// re-reads the file instead of finding a dataset without pixels.

type Core = typeof import("@cornerstonejs/core");
type Loader = typeof import("@cornerstonejs/dicom-image-loader");

interface DicomDataSet {
  byteArray: Uint8Array;
  elements: Record<string, { dataOffset: number; length: number } | undefined>;
  intString?: (tag: string) => number | undefined;
  __trimmed?: boolean;
}

/** Bytes released so far (for the bench report). */
export const memoryStats = { trimmedBytes: 0, trimmedImages: 0 };

function urlOf(imageId: string): string | null {
  if (!imageId.startsWith("wadouri:")) return null;
  // wadouri:<url>[&frame=N] — frames of a multiframe file share one dataset.
  return imageId.slice("wadouri:".length).replace(/&frame=\d+$/, "");
}

/** Pixel Data is frames → fragments → bytes; count every level. */
function bytesIn(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + bytesIn(v), 0);
  return (value as ArrayBufferView | ArrayBuffer | undefined)?.byteLength ?? 0;
}

const PIXEL_KEYS = ["PixelData", "FramePixelData", "FloatPixelData", "7FE00010", "7fe00010", "7FE00008", "7fe00008"];

/**
 * Cornerstone v5's default wadouri path keeps each file's pixel bytes inside
 * its NATURALIZED metadata entry, which is never evicted: every slice ever
 * viewed was held twice, forever. After decode, drop the pixel bytes from the
 * entry (the tags stay); on eviction, clear the entry so a reload re-reads
 * the file in full.
 */
async function installNaturalizedTrim(core: Core): Promise<void> {
  const md = await import("@cornerstonejs/metadata");
  const NATURALIZED = md.Enums.MetadataModules.NATURALIZED;
  const clearQuery = (md.metaData as unknown as { clearQuery?: (type: string, query: string) => void }).clearQuery;
  if (!clearQuery) return; // without a way to re-read, keep the bytes
  core.eventTarget.addEventListener(core.Enums.Events.IMAGE_LOADED, (event: Event) => {
    const imageId = ((event as CustomEvent).detail?.image as { imageId?: string } | undefined)?.imageId;
    if (!imageId || !urlOf(imageId)) return;
    const natural = md.metaData.get(NATURALIZED, imageId) as Record<string, unknown> | undefined;
    if (!natural || natural.__pixelsDropped) return;
    if (Number(natural.NumberOfFrames ?? 1) > 1) return; // other frames still decode from it
    let freed = 0;
    for (const key of PIXEL_KEYS) {
      const value = natural[key];
      if (Array.isArray(value)) {
        freed += bytesIn(value);
        delete natural[key];
      }
    }
    if (!freed) return;
    natural.__pixelsDropped = true;
    memoryStats.trimmedBytes += freed;
    memoryStats.trimmedImages += 1;
  });
  core.eventTarget.addEventListener(core.Enums.Events.IMAGE_CACHE_IMAGE_REMOVED, (event: Event) => {
    const imageId = (event as CustomEvent).detail?.imageId as string | undefined;
    if (!imageId || !urlOf(imageId)) return;
    const natural = md.metaData.get(NATURALIZED, imageId) as Record<string, unknown> | undefined;
    if (natural?.__pixelsDropped) clearQuery(NATURALIZED, imageId);
  });
}

export function installDatasetTrim(core: Core, loader: Loader): void {
  void installNaturalizedTrim(core).catch(() => undefined);
  const manager = (loader as unknown as { wadouri?: { dataSetCacheManager?: {
    isLoaded(uri: string): boolean;
    unload(uri: string): void;
  } } }).wadouri?.dataSetCacheManager;
  if (!manager) return;

  core.eventTarget.addEventListener(core.Enums.Events.IMAGE_LOADED, (event: Event) => {
    const image = (event as CustomEvent).detail?.image as { imageId?: string; data?: DicomDataSet } | undefined;
    const ds = image?.data;
    if (!image?.imageId || !ds?.byteArray || ds.__trimmed || !urlOf(image.imageId)) return;
    // Only images that live in the cache: an uncached decode (a thumbnail) can
    // be followed by a volume load that reuses this same dataset for pixels.
    if (!core.cache.getImageLoadObject(image.imageId)) return;
    const frames = ds.intString?.("x00280008") ?? 1;
    if (frames > 1) return; // other frames still decode from these bytes
    const pixel = ds.elements.x7fe00010;
    if (!pixel || pixel.dataOffset <= 0 || pixel.dataOffset >= ds.byteArray.length) return;
    const before = ds.byteArray.length;
    // A copy, so the large original ArrayBuffer can actually be collected.
    ds.byteArray = ds.byteArray.slice(0, pixel.dataOffset);
    ds.__trimmed = true;
    memoryStats.trimmedBytes += before - ds.byteArray.length;
    memoryStats.trimmedImages += 1;
  });

  core.eventTarget.addEventListener(core.Enums.Events.IMAGE_CACHE_IMAGE_REMOVED, (event: Event) => {
    const imageId = (event as CustomEvent).detail?.imageId as string | undefined;
    const url = imageId && urlOf(imageId);
    if (!url) return;
    // Drop every reference so a later load fetches the full file again.
    for (let i = 0; i < 64 && manager.isLoaded(url); i += 1) manager.unload(url);
  });
}

/** GPU facts for the bench report: whether volumes get 16-bit textures here. */
export function gpuInfo(): { renderer: string | null; norm16: boolean; webgl2: boolean } {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return { renderer: null, norm16: false, webgl2: false };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    const norm16 = !!gl.getExtension("EXT_texture_norm16");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { renderer, norm16, webgl2: true };
  } catch {
    return { renderer: null, norm16: false, webgl2: false };
  }
}

/** Where decoded memory sits right now (bench report). */
export function cacheFacts(core: Core | undefined, imageId?: string): Record<string, unknown> {
  if (!core) return {};
  const cache = core.cache as unknown as { getCacheSize?: () => number; getImage: (id: string) => unknown };
  const image = imageId ? (cache.getImage(imageId) as { getPixelData?: () => ArrayLike<number> } | undefined) : undefined;
  return {
    imageCacheMb: cache.getCacheSize ? Math.round(cache.getCacheSize() / 1048576) : null,
    pixelType: image?.getPixelData ? image.getPixelData().constructor.name : null,
  };
}
