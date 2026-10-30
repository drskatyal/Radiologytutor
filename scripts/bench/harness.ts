// Browser side of the viewer benchmark. Bundled by scripts/bench/run.mjs and
// served by scripts/bench/mockDicomweb.mjs; never shipped in the app.
//
// It drives the SAME code the product drives — `lib/progressiveStack.ts` for
// the streaming open, `lib/viewerRuntime.ts` for the engine knobs, the real
// Cornerstone3D stack viewport for render — against a synthetic WADO-RS
// origin with a fixed per-request latency. The only thing that differs between
// a `baseline` and a `tuned` run is the knob object in the query string, so a
// delta is attributable to the knobs and not to two different loaders.
//
// Reported metrics (ms unless stated):
//   openMs        navigation → the opening frame is on screen (time to first pixel)
//   seriesReadyMs navigation → the full imageId stack is set (scrollable)
//   coldScroll    walking N slices that were never prefetched
//   warmScroll    walking the same N slices again, all cache hits
//   scrollFps     slices/second on the warm walk
//   jsHeapMb      performance.memory after the run (Chrome only)

import type { Types } from "@cornerstonejs/core";
import {
  prefetchImageIndexes,
  prefetchNeighborImageIds,
  startProgressiveWadorsLoad,
} from "../../lib/progressiveStack";
import { directionalPrefetchIndexes, prefetchRadiusFor } from "../../lib/prefetchPlan";
import { warmOpeningFrame, warmViewerModules } from "../../lib/viewerWarmup";
import {
  coreInitConfig,
  imageCacheBytes,
  retrievalPoolSizes,
  webWorkerCount,
  type DeviceProfile,
} from "../../lib/viewerRuntime";

interface Knobs {
  label: string;
  /** Apply lib/viewerRuntime config (tuned) or the pre-change literals (baseline). */
  runtime: "baseline" | "tuned";
  /** Pass the known instance count into the progressive loader (skips QIDO paging). */
  countHint: boolean;
  /** Warm a few slices ahead on every slice change, not only on scroll pause. */
  directionalPrefetch: boolean;
  /**
   * Run lib/viewerWarmup's opening-frame warm BEFORE the engine exists, the
   * way components/viewer/ViewerPrewarm does on a case page. Models the real
   * overlap: the three round trips happen while the engine chunks download.
   */
  prewarm: boolean;
  slices: number;
  scrollSlices: number;
  studyUID: string;
  seriesUID: string;
}

const log = (line: string) => {
  const host = document.getElementById("log");
  if (host) host.textContent = `${host.textContent}\n${line}`;
  console.info(`[bench] ${line}`);
};

const knobs: Knobs = JSON.parse(
  decodeURIComponent(new URLSearchParams(location.search).get("knobs") ?? "%7B%7D")
);

const WADO_ROOT = `${location.origin}/dicomweb`;

/** The pre-change literals from components/CornerstoneViewer.tsx @ 71c006a. */
const BASELINE = {
  workers: Math.min(4, navigator.hardwareConcurrency || 4),
  pool: { interaction: 16, thumbnail: 2, prefetch: 4 },
  cacheBytes: null as number | null,
  coreInit: undefined as Record<string, unknown> | undefined,
};

async function main() {
  const t0 = performance.now();
  // A case page mounts ViewerPrewarm and the dynamic viewer in the same tick.
  // Kick the warm off first and do NOT await it — the point is the overlap.
  const prewarmed = knobs.prewarm
    ? warmOpeningFrame({
        wadoRsRoot: WADO_ROOT,
        studyInstanceUID: knobs.studyUID,
        seriesInstanceUID: knobs.seriesUID,
        instanceCount: knobs.slices,
      })
    : Promise.resolve(null);
  void prewarmed.catch(() => null);
  if (knobs.prewarm) void warmViewerModules();
  const core = await import("@cornerstonejs/core");
  const loader = await import("@cornerstonejs/dicom-image-loader");
  const tools = await import("@cornerstonejs/tools");

  const profile: DeviceProfile = {
    isMobile: false,
    cores: navigator.hardwareConcurrency || 4,
    deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory ?? 8,
    coarsePointer: false,
  };

  const workers =
    knobs.runtime === "tuned" ? webWorkerCount(profile) : BASELINE.workers;
  const pool = knobs.runtime === "tuned" ? retrievalPoolSizes(profile) : BASELINE.pool;
  const cacheBytes =
    knobs.runtime === "tuned" ? imageCacheBytes(profile) : BASELINE.cacheBytes;

  if (knobs.runtime === "tuned") {
    await core.init(coreInitConfig(profile) as Parameters<typeof core.init>[0]);
  } else {
    await core.init();
  }
  await tools.init();
  await loader.init({ maxWebWorkers: workers });
  if (cacheBytes != null) core.cache.setMaxCacheSize(cacheBytes);

  const retrieval = (
    core as unknown as {
      imageRetrievalPoolManager?: { maxNumRequests?: Record<string, number> };
    }
  ).imageRetrievalPoolManager;
  if (retrieval?.maxNumRequests) Object.assign(retrieval.maxNumRequests, pool);

  const moduleMs = Math.round(performance.now() - t0);
  log(`${knobs.label}: engine ready in ${moduleMs}ms (workers=${workers}, cache=${cacheBytes ?? "default"})`);

  const element = document.getElementById("stage") as HTMLDivElement;
  const engine = new core.RenderingEngine("bench-engine");
  engine.enableElement({
    viewportId: "bench",
    type: core.Enums.ViewportType.STACK,
    element,
  });
  const viewport = engine.getViewport("bench") as Types.IStackViewport;

  const group = tools.ToolGroupManager.createToolGroup("bench-tools");
  tools.addTool(tools.StackScrollTool);
  tools.addTool(tools.WindowLevelTool);
  group?.addTool(tools.StackScrollTool.toolName);
  group?.addTool(tools.WindowLevelTool.toolName);
  group?.addViewport("bench", "bench-engine");

  // --- open ---------------------------------------------------------------
  const navStart = performance.now();
  const job = startProgressiveWadorsLoad({
    wadoRsRoot: WADO_ROOT,
    studyInstanceUID: knobs.studyUID,
    seriesInstanceUID: knobs.seriesUID,
    open: null,
    ...(knobs.countHint ? { instanceCount: knobs.slices } : {}),
  });

  const firstPixel = new Promise<number>((resolve) => {
    const onRendered = () => {
      if (!viewport.getCurrentImageId?.()) return;
      element.removeEventListener(core.Enums.Events.IMAGE_RENDERED, onRendered);
      resolve(performance.now() - navStart);
    };
    element.addEventListener(core.Enums.Events.IMAGE_RENDERED, onRendered);
  });

  const openingId = await job.opening;
  await viewport.setStack([openingId], 0);
  viewport.render();
  const openMs = Math.round(await firstPixel);
  // Prove the frame DECODED, not merely that a render event fired: an image
  // whose metadata is missing still triggers IMAGE_RENDERED on a blank canvas,
  // so every number below would be measuring an empty viewport.
  const queued = core.imageLoader.loadAndCacheImage(openingId, {
    priority: 5,
    requestType: core.Enums.RequestType.Interaction,
  }) as
    | Promise<unknown>
    | { promise?: Promise<unknown> };
  const settled =
    queued && typeof queued === "object" && "promise" in queued ? queued.promise : queued;
  const decoded = await Promise.resolve(settled)
    .then((value) => {
      const image = value as { rows?: number; columns?: number; getPixelData?: () => ArrayLike<number> };
      return {
        rows: image?.rows,
        columns: image?.columns,
        pixels: image?.getPixelData?.().length ?? 0,
      };
    })
    .catch((error: unknown) => ({ error: String(error) }));
  log(`${knobs.label}: opening frame decoded ${JSON.stringify(decoded)}`);
  job.releaseMetadata();
  log(`${knobs.label}: first pixel ${openMs}ms`);

  const full = await job.full;
  await viewport.setStack(full.imageIds, full.openIndex);
  viewport.render();
  const seriesReadyMs = Math.round(performance.now() - navStart);
  log(`${knobs.label}: series ready ${seriesReadyMs}ms (${full.imageIds.length} images)`);

  // --- scroll -------------------------------------------------------------
  // Cold: the reader scrolls into slices nothing warmed. Each run starts from
  // the same index so both profiles cover the same frames.
  const radius = knobs.runtime === "tuned" ? prefetchRadiusFor(full.imageIds.length) : 8;
  const start = full.openIndex;
  const walk = async (from: number, count: number): Promise<number> => {
    const began = performance.now();
    for (let step = 1; step <= count; step += 1) {
      const index = Math.min(full.imageIds.length - 1, from + step);
      if (knobs.directionalPrefetch) {
        prefetchImageIndexes(
          full.imageIds,
          directionalPrefetchIndexes(full.imageIds.length, index, 1)
        );
      }
      await viewport.setImageIdIndex(index);
    }
    return performance.now() - began;
  };

  const coldScrollMs = Math.round(await walk(start, knobs.scrollSlices));
  // Symmetric pause-warm, exactly as the viewer does after NEIGHBOR_PREFETCH_DELAY_MS.
  prefetchNeighborImageIds(full.imageIds, start, radius);
  await new Promise((r) => setTimeout(r, 1500));
  const warmScrollMs = Math.round(await walk(start, Math.min(radius, knobs.scrollSlices)));
  const warmSlices = Math.min(radius, knobs.scrollSlices);

  const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  const result = {
    label: knobs.label,
    runtime: knobs.runtime,
    countHint: knobs.countHint,
    directionalPrefetch: knobs.directionalPrefetch,
    prewarm: knobs.prewarm,
    prewarmedImageId: (await prewarmed) != null,
    decoded,
    images: full.imageIds.length,
    workers,
    cacheBytes,
    prefetchRadius: radius,
    moduleMs,
    openMs,
    seriesReadyMs,
    coldScrollMs,
    coldScrollSlices: knobs.scrollSlices,
    coldMsPerSlice: Math.round((coldScrollMs / knobs.scrollSlices) * 10) / 10,
    warmScrollMs,
    warmScrollSlices: warmSlices,
    warmFps: Math.round((warmSlices / (warmScrollMs / 1000)) * 10) / 10,
    jsHeapMb: heap ? Math.round(heap.usedJSHeapSize / 1024 / 1024) : null,
    cacheMb: Math.round(core.cache.getCacheSize() / 1024 / 1024),
  };
  log(`${knobs.label}: ${JSON.stringify(result)}`);
  await fetch("/bench/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

main().catch(async (error) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  log(`FAILED: ${message}`);
  await fetch("/bench/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: knobs.label, error: message }),
  }).catch(() => undefined);
});
