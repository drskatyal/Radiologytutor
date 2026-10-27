// Progressive WADO-RS stack load.
//
// First pixel does not wait for every instance's metadata, and it does not
// wait for any other series. Order of imageIds is the series metadata array
// order (the historical Cornerstone stack order) so sliceIndex stays put.
//
// 1. If the teacher stored a SOP, fetch that one instance's metadata and
//    hand it back immediately.
// 2. Otherwise stream series metadata and hand back the teacher slice index,
//    or the middle instance, as soon as that object has been parsed.
// 3. The rest of the metadata body registers in the background. When it
//    finishes, the caller setStacks the full list and the series is scrollable.
// 4. Neighbor prefetch is a separate call, after the opening frame is requested.

import cornerstoneDICOMImageLoader from "@cornerstonejs/dicom-image-loader";
import { JsonArrayScanner } from "./jsonArrayStream";
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

export interface ProgressiveStack {
  /** Resolves once the opening instance's metadata is registered. */
  opening: Promise<string>;
  /** Resolves once every instance in the series is registered, in stack order. */
  full: Promise<{ imageIds: string[]; openIndex: number }>;
}

export function prefetchNeighborImageIds(
  imageIds: readonly string[],
  center: number,
  radius: number = ACTIVE_PREFETCH_RADIUS
): void {
  if (typeof window === "undefined") return;
  const indexes = neighborIndexes(imageIds.length, center, radius);
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

async function qidoInstanceCount(
  root: string,
  study: string,
  series: string,
  signal: AbortSignal | undefined
): Promise<number | null> {
  let total = 0;
  const page = 2000;
  for (let offset = 0; offset < 50_000; offset += page) {
    const params = new URLSearchParams({
      limit: String(page),
      offset: String(offset),
      includefield: "00200013",
    });
    const url = `${root}/studies/${study}/series/${series}/instances?${params}`;
    const res = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "default",
      headers: { Accept: JSON_ACCEPT },
    });
    if (!res.ok) return total > 0 ? total : null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) break;
    total += rows.length;
    if (rows.length < page) break;
  }
  return total > 0 ? total : null;
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
  const res = await fetch(url, {
    signal,
    credentials: "same-origin",
    cache: "force-cache",
    headers: { Accept: JSON_ACCEPT },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as unknown;
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
  signal?: AbortSignal;
}): ProgressiveStack {
  const root = input.wadoRsRoot.replace(/\/$/, "");
  const study = input.studyInstanceUID;
  const series = input.seriesInstanceUID;
  const signal = input.signal;
  const hint = input.open ?? undefined;

  let resolveOpening: (imageId: string) => void = () => undefined;
  let rejectOpening: (error: unknown) => void = () => undefined;
  let openingSettled = false;
  const opening = new Promise<string>((resolve, reject) => {
    resolveOpening = resolve;
    rejectOpening = reject;
  });

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
    const earlySop = hint?.sopInstanceUID?.trim();
    const sliceHint =
      hint?.sliceIndex != null && Number.isFinite(hint.sliceIndex)
        ? Math.max(0, Math.round(hint.sliceIndex))
        : null;
    const datasets: unknown[] = [];
    // Target index in metadata order. A stored slice is known immediately.
    // The middle slice needs a count, from a lightweight instance QIDO that
    // does not download pixel data or full metadata.
    let midTarget: number | null = sliceHint;
    const emitParsedTarget = () => {
      if (openingSettled || earlySop || midTarget == null) return;
      if (datasets.length <= midTarget) return;
      const dataset = datasets[midTarget];
      const imageId = dataset ? imageIdFor(root, study, dataset, series) : null;
      if (imageId && dataset) emit(imageId);
    };
    if (!earlySop && sliceHint == null) {
      void qidoInstanceCount(root, study, series, signal)
        .then((count) => {
          if (count == null || count <= 0 || openingSettled) return;
          midTarget = stackOpenIndex(count);
          emitParsedTarget();
        })
        .catch(() => undefined);
    }
    if (earlySop) {
      try {
        const dataset = await fetchInstanceMetadata(root, study, series, earlySop, signal);
        const imageId = dataset ? imageIdFor(root, study, dataset, series) : null;
        if (imageId && dataset) {
          registerMetadata(imageId, dataset);
          emit(imageId);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

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

    let openIndex = resolveOpenIndex(imageIds.length, sops, hint);
    if (sliceHint == null && !earlySop && !openingSettled) {
      openIndex = stackOpenIndex(imageIds.length);
    }
    const openingId = imageIds[openIndex];
    if (openingId) {
      registerMetadata(openingId, datasets[openIndex]);
      emit(openingId);
    }
    return { imageIds, openIndex };
  })().catch((err) => {
    fail(err);
    throw err;
  });

  return { opening, full };
}
