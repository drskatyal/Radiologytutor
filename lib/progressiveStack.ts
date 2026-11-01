// Progressive WADO-RS stack load.
//
// First pixel does not wait for every instance's metadata, and it does not
// wait for any other series. Order of imageIds is the series metadata array
// order (the historical Cornerstone stack order) so sliceIndex stays put.
//
// 1. Resolve the opening instance on its own: the teacher SOP, or a QIDO
//    offset for the stored slice / the middle of the series, then that one
//    instance's WADO metadata. Hand the imageId back immediately.
// 2. Wait until the caller has requested that frame (`releaseMetadata`,
//    after setStack) before fetching the series metadata document. Orthanc
//    builds that document in one shot; starting it first left the viewport
//    black with "Loading stack…" while the opening frame waited behind it.
//    If the direct instance fetch misses, the series document starts at once
//    so the stream can still emit an opening imageId.
// 3. When the body finishes, the caller setStacks the full list and the
//    series is scrollable.
// 4. Neighbor prefetch is a separate call, after the opening frame is requested.
//
// 0. Before any of that: a converted bundle (lib/dicomCdn). One small
//    same-origin call asks whether this series was converted to HTJ2K +
//    previews. If so, the opening slice paints from an 8-bit preview chunk and
//    the whole stack registers from one gzip metadata document — no QIDO, no
//    archive-built series metadata. The imageIds are the SAME wadors ids, so
//    if anything in the bundle fails the DICOMweb steps below take over
//    without the stack changing under the reader.

import cornerstoneDICOMImageLoader from "@cornerstonejs/dicom-image-loader";
import { SeriesBundle, fetchSeriesManifest } from "./dicomCdn/client";
import { attachBundle } from "./dicomCdn/cornerstoneBridge";
import { JsonArrayScanner } from "./jsonArrayStream";
import { fetchJsonShared } from "./sharedJsonFetch";
import { stackOpenIndex } from "./stackIndex";
import {
  ACTIVE_PREFETCH_RADIUS,
  dicomTagString,
  neighborIndexes,
  resolveOpenIndex,
  wadorsImageId,
  type OpenSlice,
} from "./viewerLoad";

const SOP_TAG = "00080018";
const SERIES_TAG = "0020000E";
const JSON_ACCEPT = "application/dicom+json";

/** Where the pixels come from: a converted bundle (CDN/proxy) or DICOMweb. */
export type StackSource = "bundle" | "dicomweb";

export interface ProgressiveStack {
  /** Resolves once the opening instance's metadata is registered. */
  opening: Promise<string>;
  /** Resolves once every instance in the series is registered, in stack order. */
  full: Promise<{ imageIds: string[]; openIndex: number; source: StackSource }>;
  /**
   * Start the series metadata document. Call after the opening frame request
   * is in flight so that document cannot sit ahead of the first pixels.
   */
  releaseMetadata: () => void;
}

export function prefetchNeighborImageIds(
  imageIds: readonly string[],
  center: number,
  radius: number = ACTIVE_PREFETCH_RADIUS
): void {
  prefetchImageIndexes(imageIds, neighborIndexes(imageIds.length, center, radius));
}

/**
 * Queue an explicit list of stack indexes at `prefetch` priority. The
 * directional travel warm (`lib/prefetchPlan.ts`) uses this on every slice
 * change, so it must stay cheap: no awaits before the queue call, duplicates
 * are harmless (Cornerstone's cache de-dupes by imageId), and a rejected id
 * is swallowed.
 */
export function prefetchImageIndexes(
  imageIds: readonly string[],
  indexes: readonly number[]
): void {
  if (typeof window === "undefined" || indexes.length === 0) return;
  void import("@cornerstonejs/core")
    .then((core) => {
      const loader = core.imageLoader;
      const requestType = core.Enums?.RequestType?.Prefetch;
      for (const index of indexes) {
        const imageId = imageIds[index];
        if (!imageId || !loader?.loadAndCacheImage) continue;
        try {
          const queued = loader.loadAndCacheImage(imageId, {
            priority: -5,
            requestType: requestType ?? "prefetch",
          }) as { promise?: Promise<unknown> } | Promise<unknown>;
          const promise =
            queued && typeof queued === "object" && "promise" in queued ? queued.promise : queued;
          void Promise.resolve(promise).catch(() => undefined);
        } catch {
          /* metadata not registered yet, or the loader rejected the id */
        }
      }
    })
    .catch(() => undefined);
}

function registerMetadata(imageId: string, dataset: unknown): void {
  cornerstoneDICOMImageLoader.wadors.metaDataManager.add(
    imageId,
    dataset as Parameters<typeof cornerstoneDICOMImageLoader.wadors.metaDataManager.add>[1]
  );
}

function imageIdFor(root: string, study: string, dataset: unknown, fallbackSeries: string): string | null {
  const sop = dicomTagString(dataset, SOP_TAG);
  if (!sop) return null;
  const series = dicomTagString(dataset, SERIES_TAG) || fallbackSeries;
  return wadorsImageId(root, study, series, sop);
}

async function qidoSopAt(
  root: string,
  study: string,
  series: string,
  index: number,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const params = new URLSearchParams({
    limit: "1",
    offset: String(Math.max(0, index)),
    includefield: SOP_TAG,
  });
  const url = `${root}/studies/${study}/series/${series}/instances?${params}`;
  // Shared with the page prewarm, which asks for the same row.
  const rows = await fetchJsonShared(url, { accept: JSON_ACCEPT, signal });
  if (!Array.isArray(rows) || !rows[0]) return null;
  return dicomTagString(rows[0], SOP_TAG) ?? null;
}

/** Middle SOP in QIDO order. One light page of instance UIDs, not full metadata. */
async function qidoMiddleSop(
  root: string,
  study: string,
  series: string,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const sops: string[] = [];
  const page = 2000;
  for (let offset = 0; offset < 50_000; offset += page) {
    const params = new URLSearchParams({
      limit: String(page),
      offset: String(offset),
      includefield: SOP_TAG,
    });
    const url = `${root}/studies/${study}/series/${series}/instances?${params}`;
    const res = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "default",
      headers: { Accept: JSON_ACCEPT },
    });
    if (!res.ok) return sops.length > 0 ? (sops[stackOpenIndex(sops.length)] ?? null) : null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const sop = dicomTagString(row, SOP_TAG);
      if (sop) sops.push(sop);
    }
    if (rows.length < page) break;
  }
  if (sops.length === 0) return null;
  return sops[stackOpenIndex(sops.length)] ?? null;
}

async function fetchInstanceMetadata(
  root: string,
  study: string,
  series: string,
  sop: string,
  signal: AbortSignal | undefined
): Promise<unknown | null> {
  const url =
    `${root.replace(/\/$/, "")}/studies/${study}` +
    `/series/${series}/instances/${sop}/metadata`;
  const body = await fetchJsonShared(url, { accept: JSON_ACCEPT, signal });
  if (body == null) return null;
  if (Array.isArray(body)) return body[0] ?? null;
  return body;
}

/**
 * Start a progressive load. `opening` and `full` share one metadata read
 * except when a teacher SOP is known — that instance is fetched on its own
 * so the frame request does not wait on the series body.
 */
export function startProgressiveWadorsLoad(input: {
  wadoRsRoot: string;
  studyInstanceUID: string;
  seriesInstanceUID: string;
  open?: OpenSlice | null;
  /**
   * Instances in the series when the archive already told us (the series rail
   * carries `CaseSeries.instanceCount`). With it, the opening slice is ONE
   * 1-row QIDO request at the middle offset. Without it we have to page the
   * whole SOP list just to find the midpoint — on a 1200-slice CTA that is a
   * ~90 KB JSON document in front of the first pixel.
   */
  instanceCount?: number;
  signal?: AbortSignal;
  /** False skips the converted-bundle lookup (benchmarks, tests). Default true. */
  bundles?: boolean;
}): ProgressiveStack {
  const root = input.wadoRsRoot.replace(/\/$/, "");
  const study = input.studyInstanceUID;
  const series = input.seriesInstanceUID;
  const signal = input.signal;
  const hint = input.open ?? undefined;
  const knownCount =
    input.instanceCount != null &&
    Number.isFinite(input.instanceCount) &&
    input.instanceCount > 0
      ? Math.round(input.instanceCount)
      : null;

  let resolveOpening: (imageId: string) => void = () => undefined;
  let rejectOpening: (error: unknown) => void = () => undefined;
  let openingSettled = false;
  const opening = new Promise<string>((resolve, reject) => {
    resolveOpening = resolve;
    rejectOpening = reject;
  });

  let metadataReleased = false;
  let releaseMetadataGate: () => void = () => undefined;
  const metadataGate = new Promise<void>((resolve) => {
    releaseMetadataGate = () => {
      if (metadataReleased) return;
      metadataReleased = true;
      resolve();
    };
  });
  const releaseMetadata = () => releaseMetadataGate();
  signal?.addEventListener("abort", releaseMetadata, { once: true });

  const emit = (imageId: string) => {
    if (openingSettled) return;
    openingSettled = true;
    resolveOpening(imageId);
  };
  const fail = (error: unknown) => {
    if (openingSettled) return;
    openingSettled = true;
    rejectOpening(error);
  };

  const full = (async () => {
    if (input.bundles !== false) {
      const bundled = await openFromBundle({
        root,
        study,
        series,
        hint,
        signal,
        emit: (imageId, dataset) => {
          registerMetadata(imageId, dataset);
          emit(imageId);
        },
      });
      if (bundled) return { ...bundled, source: "bundle" as const };
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }

    const earlySop = hint?.sopInstanceUID?.trim();
    const sliceHint =
      hint?.sliceIndex != null && Number.isFinite(hint.sliceIndex)
        ? Math.max(0, Math.round(hint.sliceIndex))
        : null;
    const datasets: unknown[] = [];
    // Fallback when the direct instance fetch misses: a stored slice index
    // can still be emitted as soon as the stream has parsed that object.
    // The middle slice is emitted at the end of the body.
    let midTarget: number | null = sliceHint;
    // SOP of the frame actually painted first, so the finished stack can open
    // on it rather than recomputing a midpoint from a (possibly different)
    // count. Held in an object so the closures below can write it.
    const opened: { sop?: string } = {};

    const publishDataset = (dataset: unknown) => {
      const imageId = imageIdFor(root, study, dataset, series);
      if (!imageId) return;
      registerMetadata(imageId, dataset);
      opened.sop = dicomTagString(dataset, SOP_TAG);
      emit(imageId);
    };

    try {
      if (earlySop) {
        const dataset = await fetchInstanceMetadata(root, study, series, earlySop, signal);
        if (dataset) publishDataset(dataset);
      } else {
        // A known count turns "which slice is the middle?" into one 1-row
        // QIDO at a computed offset. `midTarget` keeps the streamed fallback
        // honest if the archive count is stale and that offset is empty.
        const countedMid =
          sliceHint == null && knownCount != null ? stackOpenIndex(knownCount) : null;
        if (countedMid != null) midTarget = countedMid;
        const offset = sliceHint ?? countedMid;
        const sop =
          offset != null
            ? await qidoSopAt(root, study, series, offset, signal)
            : await qidoMiddleSop(root, study, series, signal);
        if (sop) {
          const dataset = await fetchInstanceMetadata(root, study, series, sop, signal);
          if (dataset) publishDataset(dataset);
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // The opening frame is already addressable. Hold the heavy series
    // document until that frame request is in flight (or the backstop fires
    // so a caller that never releases still gets a scrollable stack).
    if (openingSettled) {
      await Promise.race([
        metadataGate,
        new Promise<void>((resolve) => setTimeout(resolve, 12_000)),
      ]);
    } else {
      releaseMetadata();
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const emitParsedTarget = () => {
      if (openingSettled || earlySop || midTarget == null) return;
      if (datasets.length <= midTarget) return;
      const dataset = datasets[midTarget];
      const imageId = dataset ? imageIdFor(root, study, dataset, series) : null;
      if (imageId && dataset) {
        opened.sop = dicomTagString(dataset, SOP_TAG);
        emit(imageId);
      }
    };

    const url = `${root}/studies/${study}/series/${series}/metadata`;
    const res = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "default",
      headers: { Accept: JSON_ACCEPT },
    });
    if (!res.ok) {
      throw new Error(`Series metadata ${res.status}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (!/json/i.test(contentType) || !res.body) {
      throw new Error("Series metadata was not JSON");
    }

    const scanner = new JsonArrayScanner();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const take = (parsed: unknown[]) => {
      for (const dataset of parsed) {
        const imageId = imageIdFor(root, study, dataset, series);
        if (!imageId) continue;
        datasets.push(dataset);
        registerMetadata(imageId, dataset);
      }
      emitParsedTarget();
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      take(scanner.push(decoder.decode(value, { stream: true })));
    }
    const tail = decoder.decode();
    if (tail) take(scanner.push(tail));

    const imageIds: string[] = [];
    const sops: string[] = [];
    for (const dataset of datasets) {
      const imageId = imageIdFor(root, study, dataset, series);
      const sop = dicomTagString(dataset, SOP_TAG);
      if (!imageId || !sop) continue;
      imageIds.push(imageId);
      sops.push(sop);
    }
    if (imageIds.length === 0) throw new Error("Series metadata was empty");

    // The frame already on screen wins. Without this, a stale archive count
    // (we asked QIDO for offset knownCount/2) would land the finished stack
    // on realCount/2 and the image would jump under the reader.
    let openIndex = resolveOpenIndex(imageIds.length, sops, {
      ...hint,
      ...(opened.sop ? { sopInstanceUID: opened.sop } : {}),
    });
    if (sliceHint == null && !earlySop && !openingSettled) {
      openIndex = stackOpenIndex(imageIds.length);
    }
    const openingId = imageIds[openIndex];
    if (openingId) {
      registerMetadata(openingId, datasets[openIndex]);
      emit(openingId);
    }
    return { imageIds, openIndex, source: "dicomweb" as const };
  })().catch((err) => {
    fail(err);
    throw err;
  });

  return { opening, full, releaseMetadata };
}

/**
 * Bundle path for one series. Resolves null when there is no bundle or it
 * failed before the stack was complete — the caller then runs DICOMweb with
 * the same imageIds. The bundle lives until `signal` aborts (series switch,
 * unmount), then detaches from the loader and frees its memory.
 */
async function openFromBundle(input: {
  root: string;
  study: string;
  series: string;
  hint: OpenSlice | undefined;
  signal: AbortSignal | undefined;
  emit: (imageId: string, dataset: unknown) => void;
}): Promise<{ imageIds: string[]; openIndex: number } | null> {
  const { root, study, series, hint, signal } = input;
  const manifest = await fetchSeriesManifest(study, series, signal);
  if (!manifest || signal?.aborted) return null;

  const imageIds = manifest.index.sops.map((sop) => wadorsImageId(root, study, series, sop));
  const bundle = new SeriesBundle(manifest.index, manifest.delivery, 0);
  const openIndex = bundle.openIndexFor(hint);
  bundle.setCurrent(openIndex);
  const detach = attachBundle(bundle, imageIds);
  const release = () => {
    detach();
    bundle.dispose();
  };
  signal?.addEventListener("abort", release, { once: true });

  try {
    // Two small requests race for the opening slice: its preview chunk (paint
    // + metadata) and its own full frame by byte range (the swap). Nothing
    // else competes for the link until the preview is in.
    void bundle.prefetchFrame(openIndex).catch(() => undefined);
    await bundle.ensurePreviewChunk(openIndex);
    const openingMeta = bundle.metadataFor(openIndex);
    if (openingMeta) input.emit(imageIds[openIndex], openingMeta);
    // Then the rest, in reading order: full chunk under the reader, previews
    // of the whole stack, outward (lib/dicomCdn/format.planFetchOrder).
    bundle.start();
    const all = await bundle.allMetadata();
    if (all.length !== imageIds.length) throw new Error("Bundle metadata does not match its index");
    all.forEach((dataset, i) => registerMetadata(imageIds[i], dataset));
    if (!openingMeta) input.emit(imageIds[openIndex], all[openIndex]);
    return { imageIds, openIndex };
  } catch (err) {
    signal?.removeEventListener("abort", release);
    release();
    if (signal?.aborted) throw err;
    console.warn("[radlearn] converted bundle unavailable, using DICOMweb", { series, err });
    return null;
  }
}
