// ============================================================================
// lib/dicomCdn/jobs.ts  (server only)
//
// When conversions run inside the app:
//
//   after upload    `scheduleSeriesBundle` — debounced per series, because a
//                   300-slice upload arrives as many small batches. The timer
//                   restarts on every batch; the build starts once the series
//                   has been quiet for DICOM_CDN_UPLOAD_SETTLE_MS (default 45 s).
//   first view      `ensureSeriesBundle` — the manifest API found no bundle,
//                   so the viewer reads DICOMweb this time and the conversion
//                   runs in the background for the next reader.
//   backfill        scripts/dicom-cdn-backfill.ts calls buildSeriesBundle directly.
//
// One build per series per process at a time. Cloud Run runs with CPU always
// allocated (deploy/gcp: --no-cpu-throttling), so work after the response is
// sent keeps running. If an instance dies mid-build nothing is published —
// index.json is written last — and the next view schedules it again.
// ============================================================================

import { dicomCdnConfig } from "./config";
import { NotConvertibleError, buildSeriesBundle } from "./pack";
import { openBundleStore } from "./store";
import { isDicomUid } from "./format";

const SETTLE_MS = Number(process.env.DICOM_CDN_UPLOAD_SETTLE_MS ?? 45_000);
/** Don't retry a failed series on every page view. */
const FAILURE_BACKOFF_MS = 10 * 60_000;
/** Builds at once in one process: each holds ~32 decoded frames. */
const MAX_PARALLEL_BUILDS = 2;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();
const queue: Array<{ key: string; study: string; series: string }> = [];
let active = 0;

const keyOf = (study: string, series: string) => `${study}|${series}`;

function pump(): void {
  while (active < MAX_PARALLEL_BUILDS && queue.length > 0) {
    const job = queue.shift()!;
    active += 1;
    const work = run(job.study, job.series).finally(() => {
      active -= 1;
      running.delete(job.key);
      pump();
    });
    running.set(job.key, work);
  }
}

async function run(study: string, series: string): Promise<void> {
  const config = dicomCdnConfig();
  if (!config) return;
  const key = keyOf(study, series);
  try {
    const { stats } = await buildSeriesBundle(openBundleStore(config.store), study, series);
    failedAt.delete(key);
    console.info("[dicom-cdn] converted", {
      series,
      frames: stats.frames,
      fullMB: +(stats.fullBytes / 1e6).toFixed(1),
      previewMB: +(stats.previewBytes / 1e6).toFixed(2),
      sourceMB: +(stats.sourceBytes / 1e6).toFixed(1),
      ms: stats.ms,
    });
  } catch (e) {
    failedAt.set(key, Date.now());
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof NotConvertibleError) console.info("[dicom-cdn] stays on DICOMweb", { series, reason: message });
    else console.warn("[dicom-cdn] conversion failed", { series, error: message });
  }
}

function enqueue(study: string, series: string): void {
  const key = keyOf(study, series);
  if (running.has(key) || queue.some((q) => q.key === key)) return;
  queue.push({ key, study, series });
  // Placeholder so a second caller in the same tick doesn't enqueue twice.
  running.set(key, Promise.resolve());
  pump();
}

/** After an upload batch. Restarts the settle timer for that series. */
export function scheduleSeriesBundle(study: string, series: string): void {
  const config = dicomCdnConfig();
  if (!config?.autoBuild || !isDicomUid(study) || !isDicomUid(series)) return;
  const key = keyOf(study, series);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  failedAt.delete(key);
  const timer = setTimeout(() => {
    timers.delete(key);
    enqueue(study, series);
  }, SETTLE_MS);
  // Don't hold a CLI / test process open on a pending conversion.
  (timer as { unref?: () => void }).unref?.();
  timers.set(key, timer);
}

/** A reader asked for a series that has no bundle. Converts in the background. */
export function ensureSeriesBundle(study: string, series: string): "queued" | "running" | "skipped" {
  const config = dicomCdnConfig();
  if (!config?.autoBuild || !isDicomUid(study) || !isDicomUid(series)) return "skipped";
  const key = keyOf(study, series);
  if (timers.has(key)) return "queued"; // an upload is still settling
  if (running.has(key)) return "running";
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < FAILURE_BACKOFF_MS) return "skipped";
  enqueue(study, series);
  return "queued";
}
